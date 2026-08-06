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
//     children. Both replay a history flood on subscribe; debounced reconcile /
//     `tab_id` correlation absorb it.
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
  // Coalesces the startup replay flood.
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
  label: string;
}

// One child's status subscription. `live` flips true once the pane is confirmed
// (subscription_started or a baseline status) — a connection that dies before
// going live is a stale registry entry (subscribe → pane_not_found) and is
// marked `dead` silently, matching the poll's never-live silence.
interface PaneSub {
  label: string;
  tabId: string;
  socket: Socket | null;
  buffer: string;
  live: boolean;
  dead: boolean;
  // Last status emitted (dedupe so a stable status is not re-sent).
  lastStatus: string | null;
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

  constructor(
    private readonly socketPath: string,
    private readonly store: RegistryStore,
    private readonly deps: WatchDeps,
  ) {
    this.write = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.openFleet();
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
  // child that lacks a live one. Discovery backstop — closure is handled by
  // tab.closed, not here.
  private async reconcile(): Promise<void> {
    if (this.stopped) return;
    const entries = await this.readRegistry();
    for (const child of Object.values(entries)) {
      const sub = this.subs.get(child.pane_id);
      if (sub?.dead) continue;
      if (sub?.socket) {
        // Refresh label/tab_id in case the registry changed underneath us.
        sub.label = child.label;
        sub.tabId = child.tab_id;
        this.tabIndex.set(child.tab_id, child.pane_id);
        continue;
      }
      this.openSubscription(child);
    }
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
        socket: null,
        buffer: "",
        live: false,
        dead: false,
        lastStatus: null,
        seenReal: false,
      };
    sub.label = child.label;
    sub.tabId = child.tab_id;
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
    void probeAgent(this.socketPath, child.pane_id).then((status) => {
      if (status && !sub.dead && !this.stopped) {
        sub.live = true;
        this.emit(child.pane_id, sub, status);
      }
    });
  }

  private handleStatusLine(paneId: string, sub: PaneSub, raw: string): void {
    let env: {
      result?: { type?: string };
      event?: string;
      data?: { agent_status?: string };
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
        this.emit(paneId, sub, status);
      }
      return;
    }
    // error envelope (e.g. pane_not_found on a stale subscribe): the pane does
    // not exist. Mark dead so it emits nothing and is not retried — a stale
    // registry entry that was never live stays silent.
    if (env.error) sub.dead = true;
  }

  // Emit only on a change; a stable status is not re-sent.
  //
  // `unknown` is suppressed until a real status was seen: a freshly-spawned
  // child's harness briefly reports `unknown` while booting (spawn's own
  // verify-and-rename treats it the same way), and emitting it would read as
  // `gone` downstream and wake the parent for a child that is fine. Once a
  // real status landed, `unknown` is a genuine loss (agent dead, tab open) and
  // is emitted.
  private emit(paneId: string, sub: PaneSub, status: string): void {
    const isUnknown = status === "unknown";
    if (isUnknown && !sub.seenReal) return;
    if (sub.lastStatus === status) return;
    if (!isUnknown) sub.seenReal = true;
    sub.lastStatus = status;
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

  // --- fleet: pane.created (discovery) + tab.closed (closure) ------------

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
              subscriptions: [{ type: "pane.created" }, { type: "tab.closed" }],
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
    socket.on("data", (chunk: Buffer) => {
      this.fleetBuffer += chunk.toString();
      let nl: number;
      while ((nl = this.fleetBuffer.indexOf("\n")) >= 0) {
        const line = this.fleetBuffer.slice(0, nl);
        this.fleetBuffer = this.fleetBuffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let env: { event?: string; data?: { tab_id?: string } };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        // pane_created (underscore) → discover; tab_closed (underscore) → closure.
        if (env.event === "pane_created") this.scheduleReconcile();
        else if (env.event === "tab_closed" && env.data?.tab_id) this.handleClose(env.data.tab_id);
      }
    });
    socket.on("error", () => this.handleFleetDeath());
    socket.on("close", () => this.handleFleetDeath());
  }

  // A tracked child's tab closed. closed (deliberate helper close removed it
  // from the registry first) vs gone (still tracked). The registry decides.
  private async handleClose(tabId: string): Promise<void> {
    if (this.stopped) return;
    const paneId = this.tabIndex.get(tabId);
    if (!paneId) return; // not one of our children
    const sub = this.subs.get(paneId);
    if (!sub) return;
    const entries = await this.readRegistry();
    if (this.stopped) return;
    const stillTracked = Object.prototype.hasOwnProperty.call(entries, paneId);
    sub.dead = true;
    sub.socket?.destroy();
    sub.socket = null;
    this.subs.delete(paneId);
    this.tabIndex.delete(tabId);
    const status = stillTracked ? "gone" : "closed";
    this.write(JSON.stringify({ pane_id: paneId, label: sub.label, status }));
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
    }, interval);
  }

  private async readRegistry(): Promise<Record<string, RegistryChild>> {
    try {
      const entries = (await this.store.read()) as Record<string, RegistryChild>;
      return entries ?? {};
    } catch {
      return {};
    }
  }
}

// One-shot agent.get on its own connection. Returns the current status, or null
// if the pane is gone / has no detected agent.
function probeAgent(socketPath: string, paneId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = createConnection(socketPath, () => {
      s.write(JSON.stringify({ id: "probe", method: "agent.get", params: { target: paneId } }) + "\n");
    });
    let buf = "";
    let done = false;
    const finish = (v: string | null) => {
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
            result?: { agent?: { agent_status?: string } };
          };
          finish(env.result?.agent?.agent_status ?? null);
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
