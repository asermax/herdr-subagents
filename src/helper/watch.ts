import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { fileRegistryStore, type RegistryStore } from "./registry.js";
import { HerdrError } from "./herdr-types.js";

// `watch`: a long-lived stream of child-status changes for the current parent,
// one line of JSON per change. FULLY EVENT-DRIVEN (no polling) — verified
// against herdr 0.8.0, whose relevant behaviors are:
//
//   - A subscription connection is event-only: any other request on it resets
//     it. So each tracked child gets its OWN socket with exactly one
//     `events.subscribe` for `pane.agent_status_changed` (one subscribe per
//     connection; one stale pane in a multi-pane batch fails the whole batch).
//     A stale/gone pane therefore kills only its own stream. (The previous
//     event-driven watch multiplexed subscribes on one connection and died on
//     the first stale pane — commit ee969c9.)
//   - The baseline current status is read with a SEPARATE one-shot `agent.get`
//     (not on the subscription socket); subscriptions deliver changes, not state.
//   - `pane.agent_status_changed` emits with a DOT and a `data` wrapper; a dead
//     harness (tab still open) surfaces here as `unknown`, which the parent-role
//     consumer normalizes to `gone`.
//   - Closing a tab does NOT close the pane's status socket and does NOT emit
//     `pane.closed`/`pane.exited` — but it DOES emit `tab.closed` (subscribe
//     dot, emit underscore `tab_closed`, carries `data.tab_id`). So closure is
//     detected from `tab.closed`, correlated by `tab_id` against the registry:
//     child already removed → `closed` (deliberate helper close); still tracked
//     → `gone` (unexpected). `pane.created` (emit `pane_created`) discovers new
//     children. herdr < 0.9 replayed a history flood on subscribe (0.9 starts
//     live); the debounced reconcile / `tab_id` correlation absorb either.
//   - Disposing a worktree workspace (`worktree remove` — the last-child close
//     path) emits `worktree_removed` + `workspace_closed` and NO `tab_closed`
//     per tab (verified against herdr 0.9.0), so those two events are closure
//     signals too, correlated by `workspace_id` against the tracked children.
//
// spawn writes the registry right after tabCreate (before agentStart), so a
// `pane_created` reconcile finds the child already tracked. The registry is
// parent-pane-scoped (~/.cache/herdr-subagents/registry/<HERDR_PANE_ID>.json)
// and is the source of truth for WHICH children are tracked, their labels, and
// their `tab_id`s.

export interface WatchLine {
  pane_id: string;
  label: string;
  status: string;
}

export interface WatchDeps {
  store: RegistryStore;
  out?: (line: string) => void;
  // Debounce window (ms) for the reconcile triggered by a `pane_created` event.
  // Coalesces a burst of creations (and the pre-0.9 startup replay flood).
  createdDebounceMs?: number;
  // Interval (ms) of the safety reconcile that reopens disconnected/missing
  // subscriptions (discovery backstop for a missed event or a dropped fleet
  // socket). <= 0 disables it. NOT a status or liveness poll.
  safetyReconcileMs?: number;
  // Base delay (ms) for reconnecting the fleet (pane.created + tab.closed)
  // connection.
  fleetReconnectMs?: number;
}

interface RegistryChild {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label: string;
}

// One child's status subscription. `live` flips true once the pane is confirmed
// (subscription_started or a baseline status) — a connection that dies before
// going live is a stale registry entry (subscribe → pane_not_found) and is
// marked `dead` silently, matching the poll's never-live silence.
interface PaneSub {
  label: string;
  tabId: string;
  workspaceId: string;
  socket: Socket | null;
  buffer: string;
  live: boolean;
  dead: boolean;
  // Last status emitted, with the sequence it was emitted at. Dedupe is on the
  // PAIR: two consecutive `done`s are two finished turns, and dropping the
  // second would lose a wake (ADR-0008).
  lastStatus: string | null;
  lastSeq: number | null;
  // True once a real (non-`unknown`) status was observed. `unknown` before
  // this point is a still-booting agent, not a loss, and is suppressed.
  seenReal: boolean;
}

class WatchEngine {
  private readonly write: (line: string) => void;
  private readonly subs = new Map<string, PaneSub>();
  // tab_id → pane_id, to correlate `tab_closed` events to a tracked child.
  private readonly tabIndex = new Map<string, string>();
  private fleet: Socket | null = null;
  private fleetBuffer = "";
  private fleetDead = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  // Reconciles are serialized: two overlapping reconciles reading the registry
  // at different moments could prune a sub the other just opened (a child
  // added between the two reads). One at a time, the read is the truth.
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly socketPath: string,
    private readonly store: RegistryStore,
    private readonly deps: WatchDeps,
  ) {
    this.write = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  }

  // Fleet first, registry second: since herdr 0.9 a subscription starts live,
  // so a child spawned between the registry read and the subscribe would be
  // seen by neither. Subscribing first makes the reconcile the snapshot.
  async start(): Promise<void> {
    this.openFleet();
    await this.reconcile();
    this.startSafety();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const sub of this.subs.values()) {
      sub.dead = true;
      sub.socket?.destroy();
    }
    this.subs.clear();
    this.tabIndex.clear();
    this.fleet?.destroy();
    this.fleet = null;
  }

  // Read the registry and (re)open a status subscription for every tracked
  // child that lacks a live one, and drop any sub whose child left the
  // registry (a deliberate close whose closure event was missed — worktree
  // disposal emits no tab_closed; a fleet blip can drop one). Discovery
  // backstop and closure backstop in one pass.
  private reconcile(): Promise<void> {
    this.reconcileChain = this.reconcileChain.then(() => this.doReconcile());
    return this.reconcileChain;
  }

  private async doReconcile(): Promise<void> {
    if (this.stopped) return;
    const entries = await this.readRegistry();
    if (entries === null) return; // unreadable — pruning on a bad read would drop live children
    for (const [paneId, sub] of this.subs) {
      if (sub.dead) continue;
      if (Object.prototype.hasOwnProperty.call(entries, paneId)) continue;
      // Registry-first: an entry that vanished was removed by a deliberate
      // close, so the terminal line is `closed` — the fleet line shrinks, no wake.
      this.dropSub(paneId, sub, "closed");
    }
    for (const child of Object.values(entries)) {
      const sub = this.subs.get(child.pane_id);
      if (sub?.dead) continue;
      if (sub?.socket) {
        // Refresh label/tab_id in case the registry changed underneath us.
        sub.label = child.label;
        sub.tabId = child.tab_id;
        sub.workspaceId = child.workspace_id;
        this.tabIndex.set(child.tab_id, child.pane_id);
        continue;
      }
      this.openSubscription(child);
    }
  }

  // Tear down one child's stream and write its terminal line. Shared by the
  // closure events and the reconcile prune.
  private dropSub(paneId: string, sub: PaneSub, status: string): void {
    sub.dead = true;
    sub.socket?.destroy();
    sub.socket = null;
    this.subs.delete(paneId);
    this.tabIndex.delete(sub.tabId);
    this.write(JSON.stringify({ pane_id: paneId, label: sub.label, status }));
  }

  // One connection per child: ONE subscribe (pane.agent_status_changed). The
  // baseline status comes from a separate one-shot agent.get.
  private openSubscription(child: RegistryChild): void {
    if (this.stopped) return;
    if (this.subs.has(child.pane_id) && this.subs.get(child.pane_id)?.socket) return;
    const sub: PaneSub =
      this.subs.get(child.pane_id) ?? {
        label: child.label,
        tabId: child.tab_id,
        workspaceId: child.workspace_id,
        socket: null,
        buffer: "",
        live: false,
        dead: false,
        lastStatus: null,
        lastSeq: null,
        seenReal: false,
      };
    sub.label = child.label;
    sub.tabId = child.tab_id;
    sub.workspaceId = child.workspace_id;
    sub.buffer = "";
    sub.live = false;
    sub.dead = false;
    this.subs.set(child.pane_id, sub);
    this.tabIndex.set(child.tab_id, child.pane_id);

    let socket: Socket;
    try {
      socket = createConnection(this.socketPath, () => {
        socket.write(
          JSON.stringify({
            id: `sub:${child.pane_id}`,
            method: "events.subscribe",
            params: {
              subscriptions: [{ type: "pane.agent_status_changed", pane_id: child.pane_id }],
            },
          }) + "\n",
        );
      });
    } catch {
      // connect threw — leave socket null; safety reconcile retries.
      return;
    }
    sub.socket = socket;

    socket.on("data", (chunk: Buffer) => {
      sub.buffer += chunk.toString();
      let nl: number;
      while ((nl = sub.buffer.indexOf("\n")) >= 0) {
        const line = sub.buffer.slice(0, nl);
        sub.buffer = sub.buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        this.handleStatusLine(child.pane_id, sub, line);
      }
    });
    socket.on("error", () => this.handleDisconnect(child.pane_id));
    socket.on("close", () => this.handleDisconnect(child.pane_id));

    // Baseline current status on a SEPARATE one-shot connection. Subscriptions
    // deliver changes only; this seeds the live status on subscribe. A gone /
    // not-yet-detected pane answers agent_not_found (null) → nothing; a booting
    // agent answers `unknown`, which emit() suppresses until a real status lands.
    void probeAgent(this.socketPath, child.pane_id).then((probed) => {
      if (probed && !sub.dead && !this.stopped) {
        sub.live = true;
        this.emit(child.pane_id, sub, probed.status, probed.seq);
      }
    });
  }

  private handleStatusLine(paneId: string, sub: PaneSub, raw: string): void {
    let env: {
      result?: { type?: string };
      event?: string;
      data?: { agent_status?: string; state_change_seq?: number };
      error?: { code?: string };
    };
    try {
      env = JSON.parse(raw);
    } catch {
      return;
    }
    if (env.result?.type === "subscription_started") {
      sub.live = true;
      return;
    }
    if (env.event === "pane.agent_status_changed") {
      const status = env.data?.agent_status;
      if (typeof status === "string") {
        sub.live = true;
        // The event carries the status but no `state_change_seq`; a probe
        // supplies it so a repeat of the same status is still recognised as a
        // new turn. The event's status is what we report — it is the state the
        // child really entered.
        void probeAgent(this.socketPath, paneId).then((probed) => {
          if (sub.dead || this.stopped) return;
          this.emit(paneId, sub, status, probed?.seq ?? env.data?.state_change_seq);
        });
      }
      return;
    }
    // error envelope (e.g. pane_not_found on a stale subscribe): the pane does
    // not exist. A sub that was never live is a stale registry entry — silent
    // dead, no retry. A sub that WAS live lost a real pane (herdr restart
    // renumbered ids, or the pane vanished without tab_closed): dispose it so
    // the parent learns gone/closed instead of the child sticking on the
    // fleet line forever.
    if (env.error) {
      if (sub.live || sub.seenReal) void this.dispose(paneId);
      else sub.dead = true;
    }
  }

  // Emit only on a change; a stable status is not re-sent.
  //
  // `unknown` is suppressed until a real status was seen: a freshly-spawned
  // child's harness briefly reports `unknown` while booting (spawn's own
  // verify-and-rename treats it the same way), and emitting it would read as
  // `gone` downstream and wake the parent for a child that is fine. Once a
  // real status landed, `unknown` is a genuine loss (agent dead, tab open) and
  // is emitted.
  private emit(paneId: string, sub: PaneSub, status: string, seq?: number): void {
    const isUnknown = status === "unknown";
    if (isUnknown && !sub.seenReal) return;
    // Dedupe on the (status, sequence) pair: the same status at the same
    // sequence is the state already reported, but the same status at a NEW
    // sequence is a new turn and must be emitted. With no sequence available,
    // fall back to status-only dedupe.
    if (sub.lastStatus === status && (seq === undefined || sub.lastSeq === seq)) return;
    if (!isUnknown) sub.seenReal = true;
    sub.lastStatus = status;
    sub.lastSeq = seq ?? null;
    this.write(JSON.stringify({ pane_id: paneId, label: sub.label, status }));
  }

  // A status socket dropped. If it never went live it was a stale subscribe
  // (silent dead); otherwise it is a transport blip on a real pane — clear the
  // socket so the safety reconcile reopens it. Closure is NOT inferred here.
  private handleDisconnect(paneId: string): void {
    const sub = this.subs.get(paneId);
    if (!sub || sub.dead || !sub.socket) return;
    sub.socket.destroy();
    sub.socket = null;
    if (!sub.live) sub.dead = true;
  }

  // --- fleet: pane.created (discovery) + tab.closed / workspace disposal ---

  private openFleet(): void {
    if (this.stopped || this.fleet) return;
    let socket: Socket;
    try {
      socket = createConnection(this.socketPath, () => {
        socket.write(
          JSON.stringify({
            id: "fleet",
            method: "events.subscribe",
            params: {
              subscriptions: [
                { type: "pane.created" },
                { type: "tab.closed" },
                { type: "worktree.removed" },
                { type: "workspace.closed" },
              ],
            },
          }) + "\n",
        );
      });
    } catch {
      this.scheduleFleetReconnect();
      return;
    }
    this.fleet = socket;
    this.fleetDead = false;
    this.fleetBuffer = "";
    socket.on("data", (chunk: Buffer) => {
      this.fleetBuffer += chunk.toString();
      let nl: number;
      while ((nl = this.fleetBuffer.indexOf("\n")) >= 0) {
        const line = this.fleetBuffer.slice(0, nl);
        this.fleetBuffer = this.fleetBuffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let env: {
          event?: string;
          data?: { tab_id?: string; workspace?: { workspace_id?: string } };
          error?: unknown;
        };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        // A rejected subscribe (error envelope) leaves the connection open but
        // event-less forever — treat it as a fleet death so the reconnect loop
        // replaces it.
        if (env.error) {
          this.handleFleetDeath();
          return;
        }
        // pane_created → discover; tab_closed → closure; worktree_removed /
        // workspace_closed → closure of every child in that workspace.
        if (env.event === "pane_created") {
          this.scheduleReconcile();
        } else if (env.event === "tab_closed" && env.data?.tab_id) {
          this.handleClose(env.data.tab_id);
        } else if (
          (env.event === "worktree_removed" || env.event === "workspace_closed") &&
          env.data?.workspace?.workspace_id
        ) {
          this.handleWorkspaceClosed(env.data.workspace.workspace_id);
        }
      }
    });
    socket.on("error", () => this.handleFleetDeath());
    socket.on("close", () => this.handleFleetDeath());
  }

  // A tracked child's tab closed. closed (deliberate helper close removed it
  // from the registry first) vs gone (still tracked). The registry decides.
  private handleClose(tabId: string): void {
    if (this.stopped) return;
    const paneId = this.tabIndex.get(tabId);
    if (!paneId) return; // not one of our children
    void this.dispose(paneId);
  }

  // A workspace closed or a worktree was removed. `worktree remove` disposes
  // the checkout, the workspace, and every tab in it WITHOUT emitting
  // tab_closed — this is the only closure signal for a worktree child.
  private handleWorkspaceClosed(workspaceId: string): void {
    if (this.stopped) return;
    for (const [paneId, sub] of [...this.subs]) {
      if (sub.workspaceId === workspaceId) void this.dispose(paneId);
    }
  }

  // Dispose one child and write its terminal line. Still tracked in the
  // registry → `gone` (unexpected loss, wakes); removed → `closed`
  // (deliberate). The claim is synchronous — worktree disposal delivers two
  // events for the same workspace, and both would otherwise race the async
  // registry read and emit twice. An unreadable registry releases the claim
  // and defers the decision to the reconcile prune rather than guessing.
  private async dispose(paneId: string): Promise<void> {
    if (this.stopped) return;
    const sub = this.subs.get(paneId);
    if (!sub || sub.dead) return;
    sub.dead = true;
    const entries = await this.readRegistry();
    if (this.stopped) return;
    if (entries === null) {
      sub.dead = false;
      return;
    }
    const stillTracked = Object.prototype.hasOwnProperty.call(entries, paneId);
    this.dropSub(paneId, sub, stillTracked ? "gone" : "closed");
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    const delay = this.deps.createdDebounceMs ?? 80;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile();
    }, delay);
  }

  private handleFleetDeath(): void {
    if (this.stopped || this.fleetDead) return;
    this.fleetDead = true;
    this.fleet?.destroy();
    this.fleet = null;
    this.scheduleFleetReconnect();
  }

  private scheduleFleetReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.deps.fleetReconnectMs ?? 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.openFleet();
      void this.reconcile();
    }, delay);
  }

  private startSafety(): void {
    const interval = this.deps.safetyReconcileMs ?? 30_000;
    if (interval <= 0) return;
    this.safetyTimer = setInterval(() => {
      void this.reconcile();
      void this.reprobeLive();
    }, interval);
  }

  // Re-read every live child's state and emit anything that differs from what
  // was last emitted. A subscription can stop delivering without closing —
  // nothing else would notice, and every wake after that point would be lost.
  // Not a status poll: it emits only on a difference, and the event stream
  // remains the fast path.
  private async reprobeLive(): Promise<void> {
    if (this.stopped) return;
    for (const [paneId, sub] of this.subs) {
      if (sub.dead || !sub.socket) continue;
      const probed = await probeAgent(this.socketPath, paneId);
      if (this.stopped || sub.dead || !probed) continue;
      this.emit(paneId, sub, probed.status, probed.seq);
    }
  }

  // null = the store could not be read; callers must not treat that as empty
  // (pruning on a bad read would drop live children).
  private async readRegistry(): Promise<Record<string, RegistryChild> | null> {
    try {
      const entries = (await this.store.read()) as Record<string, RegistryChild>;
      return entries ?? {};
    } catch {
      return null;
    }
  }
}

// One-shot agent.get on its own connection. Returns the current status and
// state sequence, or null if the pane is gone / has no detected agent.
interface ProbedAgent {
  status: string;
  seq?: number;
}

function probeAgent(socketPath: string, paneId: string): Promise<ProbedAgent | null> {
  return new Promise((resolve) => {
    const s = createConnection(socketPath, () => {
      s.write(JSON.stringify({ id: "probe", method: "agent.get", params: { target: paneId } }) + "\n");
    });
    let buf = "";
    let done = false;
    const finish = (v: ProbedAgent | null) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          const env = JSON.parse(buf.slice(0, nl)) as {
            result?: { agent?: { agent_status?: string; state_change_seq?: number } };
          };
          const agent = env.result?.agent;
          if (!agent?.agent_status) {
            finish(null);
          } else {
            finish(
              agent.state_change_seq === undefined
                ? { status: agent.agent_status }
                : { status: agent.agent_status, seq: agent.state_change_seq },
            );
          }
        } catch {
          finish(null);
        }
      }
    });
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
    setTimeout(() => finish(null), 3000);
  });
}

export function watchChildren(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const engine = new WatchEngine(socketPath, deps.store, deps);
    const finish = (): void => resolve();
    void engine.start().then(() => {
      if (signal?.aborted) {
        engine.stop();
        finish();
        return;
      }
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            engine.stop();
            finish();
          },
          { once: true },
        );
      }
      // No signal: run for the process lifetime; runWatch always supplies one.
    });
  });
}

// Convenience for the CLI: builds the registry store from the environment and
// runs watch against the env-configured socket.
export async function runWatch(): Promise<void> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    throw new HerdrError(
      "missing_socket_path",
      "HERDR_SOCKET_PATH is not set; cannot reach herdr",
    );
  }
  const store = fileRegistryStore();
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await watchChildren(socketPath, { store }, controller.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
