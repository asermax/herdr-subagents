// A stub herdr socket server for black-box tests. Speaks newline-delimited
// JSON-RPC. It supports two methods:
//
// - `events.subscribe` (stream): acks `subscription_started`, then pushes
//   every scripted status event whose pane the connection subscribed to.
// - `events.wait` (one-shot): replies with the first scripted event matching
//   the requested pane/status, or times out.
//
// Mirrors real herdr: it does NOT filter by `from_seq`. The scripted event
// timeline is delivered as-is, including events at or below any seq the
// client might carry — the client filters stale events itself. Filtering
// server-side would paper over the exact bug the client must defend against.

import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

export interface ScriptedEvent {
  paneId: string;
  status: string;
  seq: number;
  // Delay before the event becomes available, in ms. Lets tests model the
  // stall window: an event that never appears within the window = dropped.
  delayMs?: number;
  // Deliver only on the Nth subscribe/wait for this pane (1-based). Models a
  // dropped first prompt: the first attempt sees nothing and times out, the
  // resend's attempt matches.
  deliverOnAttempt?: number;
}

export interface StreamedChange {
  paneId: string;
  status: string;
  // Delay before the change is pushed, in ms.
  delayMs?: number;
}

export interface StubServerOptions {
  // Events the server will surface, in order. A subscribe/wait matches when an
  // event for the pane with a requested status is due. No seq filtering —
  // stale events (seq at or below any client `from_seq`) are delivered and
  // left for the client to drop, exactly as real herdr does.
  events?: ScriptedEvent[];
}

export class StubHerdrServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private events: ScriptedEvent[] = [];
  private streamQueue: StreamedChange[] = [];
  private sockets = new Set<Socket>();
  private tmpDir: string;
  // Per-method attempt counters keyed by pane: how many subscribe connections
  // or wait requests have targeted this pane. Drives `deliverOnAttempt`.
  private subAttempts: Record<string, number> = {};
  private waitAttempts: Record<string, number> = {};
  // Per-pane current status returned to an `agent.get` probe. Only set
  // explicitly; unset panes answer agent_not_found and so emit no probe line
  // (keeps the change-only tests unchanged).
  private currentStatuses: Record<string, string> = {};
  // Panes explicitly marked gone: agent.get answers agent_not_found (the
  // stale-registry case that would make herdr reset a real connection).
  private stalePanes = new Set<string>();
  // Per-connection state: panes subscribed (pane-scoped keyed on pane_id,
  // pane.created keyed on the type), which scripted events it already received
  // (so a re-subscribe does not replay), and which queued stream changes it
  // already received.
  private connState = new Map<
    Socket,
    { watched: Set<string>; scriptedDelivered: Set<number>; streamedDelivered: Set<number> }
  >();

  constructor(opts: StubServerOptions = {}) {
    this.tmpDir = mkdtempSync(join(tmpdir(), "herdr-stub-"));
    this.socketPath = join(this.tmpDir, "herdr.sock");
    this.events = [...(opts.events ?? [])];
  }

  script(events: ScriptedEvent[]): void {
    this.events = events;
  }

  // Set the current status a `watch` probe (agent.get) reads for a pane.
  setCurrentStatus(paneId: string, status: string): void {
    this.currentStatuses[paneId] = status;
  }

  // Mark a pane gone: agent.get answers agent_not_found for it (models a stale
  // registry entry — a child closed outside `helper close`).
  markStale(paneId: string): void {
    this.stalePanes.add(paneId);
  }

  // Append changes to the stream queue. Each subscriber gets every change
  // whose pane it subscribed to, exactly once (delivery is tracked per
  // connection so a re-subscribe for a new pane does not replay old ones).
  stream(changes: StreamedChange[]): void {
    for (const c of changes) this.streamQueue.push(c);
    // Re-evaluate delivery for every live connection (a stream() call after a
    // re-subscribe must reach the new pane).
    for (const socket of this.sockets) this.deliverStreamed(socket);
  }

  // Broadcast a pane.created event to every connection subscribed to it. A
  // pane.created subscription is workspace-wide (no pane_id), so any
  // connection that subscribed to the type receives it.
  pushPaneCreated(paneId: string): void {
    for (const socket of this.sockets) {
      const state = this.connState.get(socket);
      if (!state || !state.watched.has("pane.created")) continue;
      if (!this.sockets.has(socket)) continue;
      socket.write(
        JSON.stringify({
          event: "pane.created",
          data: { pane_id: paneId },
        }) + "\n",
      );
    }
  }

  // Broadcast a pane.closed event to every connection subscribed to it. A
  // pane.closed subscription is workspace-wide (no pane_id), so any
  // connection that subscribed to the type receives it.
  pushPaneClosed(paneId: string): void {
    for (const socket of this.sockets) {
      const state = this.connState.get(socket);
      if (!state || !state.watched.has("pane.closed")) continue;
      if (!this.sockets.has(socket)) continue;
      socket.write(
        JSON.stringify({
          event: "pane.closed",
          data: { pane_id: paneId },
        }) + "\n",
      );
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handle(socket));
      this.server.on("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
    rmSync(this.tmpDir, { recursive: true, force: true });
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    this.connState.set(socket, {
      watched: new Set(),
      scriptedDelivered: new Set(),
      streamedDelivered: new Set(),
    });
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.respond(line, socket);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.connState.delete(socket);
    });
    socket.on("error", () => {
      this.sockets.delete(socket);
      this.connState.delete(socket);
    });
  }

  private handleSubscribe(
    req: {
      id: string | number;
      params: { subscriptions?: Array<{ type: string; pane_id?: string }> };
    },
    socket: Socket,
  ): void {
    const subs = req.params.subscriptions ?? [];
    const state = this.connState.get(socket) ?? {
      watched: new Set<string>(),
      scriptedDelivered: new Set<number>(),
      streamedDelivered: new Set<number>(),
    };
    // pane.created subscriptions carry no pane_id; we key them on the type so
    // pushPaneCreated can find subscribers. pane-scoped subscriptions key on
    // the pane_id. Bump the per-pane subscribe attempt the first time this
    // connection subscribes to it — that is what `deliverOnAttempt` keys on.
    for (const s of subs) {
      const key = s.pane_id ?? s.type;
      if (s.pane_id && !state.watched.has(key)) {
        this.subAttempts[s.pane_id] = (this.subAttempts[s.pane_id] ?? 0) + 1;
      }
      state.watched.add(key);
    }
    this.connState.set(socket, state);
    socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
    this.deliverScripted(socket);
    this.deliverStreamed(socket);
  }

  // Push every scripted event whose pane this connection now watches, marking
  // each delivered so a later re-subscribe does not replay it. No `from_seq`
  // filtering — stale events are delivered and left to the client to drop.
  private deliverScripted(socket: Socket): void {
    const state = this.connState.get(socket);
    if (!state) return;
    this.events.forEach((ev, idx) => {
      if (state.scriptedDelivered.has(idx)) return;
      if (!state.watched.has(ev.paneId)) return;
      if (ev.deliverOnAttempt !== undefined) {
        const attempt = this.subAttempts[ev.paneId] ?? 0;
        if (attempt !== ev.deliverOnAttempt) return;
      }
      state.scriptedDelivered.add(idx);
      const push = () => {
        if (!this.sockets.has(socket)) return;
        socket.write(
          JSON.stringify({
            event: "pane.agent_status_changed",
            data: {
              pane_id: ev.paneId,
              agent_status: ev.status,
              state_change_seq: ev.seq,
            },
          }) + "\n",
        );
      };
      if (ev.delayMs) setTimeout(push, ev.delayMs);
      else push();
    });
  }

  // Push every queued stream change whose pane this connection now watches,
  // marking each delivered so a later re-subscribe does not replay it.
  private deliverStreamed(socket: Socket): void {
    const state = this.connState.get(socket);
    if (!state) return;
    this.streamQueue.forEach((change, idx) => {
      if (state.streamedDelivered.has(idx)) return;
      if (!state.watched.has(change.paneId)) return;
      state.streamedDelivered.add(idx);
      const push = () => {
        if (!this.sockets.has(socket)) return;
        socket.write(
          JSON.stringify({
            event: "pane.agent_status_changed",
            data: { pane_id: change.paneId, agent_status: change.status },
          }) + "\n",
        );
      };
      if (change.delayMs) setTimeout(push, change.delayMs);
      else push();
    });
  }

  private respond(raw: string, socket: Socket): void {
    let req: {
      id: string | number;
      method: string;
      params: {
        match_event?: {
          pane_id?: string;
          agent_status?: string[];
        };
        subscriptions?: Array<{ type: string; pane_id: string }>;
        timeout_ms?: number;
      };
    };
    try {
      req = JSON.parse(raw);
    } catch {
      return;
    }
    if (req.method === "events.subscribe") {
      this.handleSubscribe(req, socket);
      return;
    }
    if (req.method === "agent.get") {
      const target = (req.params as { target?: string }).target ?? "";
      if (this.stalePanes.has(target)) {
        socket.write(
          JSON.stringify({ id: req.id, error: { code: "agent_not_found", message: "stale pane" } }) + "\n",
        );
        return;
      }
      // Default to a live "idle" agent so registered children subscribe in
      // tests (real herdr returns agent_info for a spawned child).
      const status = this.currentStatuses[target] ?? "idle";
      socket.write(
        JSON.stringify({ id: req.id, result: { type: "agent_info", agent: { agent_status: status } } }) + "\n",
      );
      return;
    }
    if (req.method !== "events.wait") return;

    const paneId = req.params.match_event?.pane_id ?? "";
    const statuses = req.params.match_event?.agent_status ?? [];

    this.waitAttempts[paneId] = (this.waitAttempts[paneId] ?? 0) + 1;
    const attempt = this.waitAttempts[paneId];

    // No `from_seq` filtering — real herdr does not implement it, so the stub
    // must not either. Deliver the first scripted event matching the pane and
    // status (and deliverOnAttempt), regardless of seq.
    const due = this.events.find(
      (e) =>
        e.paneId === paneId &&
        statuses.includes(e.status) &&
        (e.deliverOnAttempt === undefined || e.deliverOnAttempt === attempt),
    );

    const reply = (envelope: object) => {
      socket.write(JSON.stringify(envelope) + "\n");
    };

    if (!due) {
      // No matching event — emulate a timeout. We never reply; the client's
      // own timeout fires. (Optionally reply with an error for faster tests.)
      const timeoutMs = req.params.timeout_ms ?? 1000;
      setTimeout(() => {
        if (this.sockets.has(socket)) {
          reply({ id: req.id, error: { code: "wait_timeout", message: "no matching event" } });
        }
      }, Math.min(timeoutMs, 1000));
      return;
    }

    const send = () => {
      if (!this.sockets.has(socket)) return;
      reply({
        id: req.id,
        result: {
          type: "wait_matched",
          event: {
            event: "pane_agent_status_changed",
            data: {
              pane_id: due.paneId,
              agent_status: due.status,
              state_change_seq: due.seq,
            },
          },
        },
      });
    };
    if (due.delayMs) setTimeout(send, due.delayMs);
    else send();
  }
}
