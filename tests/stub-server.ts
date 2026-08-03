// A stub herdr socket server for black-box tests. Speaks newline-delimited
// JSON-RPC: answers `events.wait` requests by matching the requested statuses
// against a scripted event timeline, and times out when none match.
//
// Tests script the server with a list of status events to emit for each pane.
// The helper's real socket client (waitForStatusOverSocket) connects here, so
// the framing of `events.wait` — the load-bearing socket call — is exercised.

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
  // Deliver only on the Nth matching `events.wait` for this pane (1-based).
  // Models a dropped first prompt: the first wait sees nothing and times out,
  // the resend's wait matches.
  deliverOnAttempt?: number;
}

export interface StreamedChange {
  paneId: string;
  status: string;
  // Delay before the change is pushed, in ms.
  delayMs?: number;
}

export interface StubServerOptions {
  // Events the server will surface, in order. A `events.wait` matches when an
  // event for the pane with a requested status (and seq > fromSeq) is due.
  events?: ScriptedEvent[];
  // When no matching event arrives, the server replies with this error after
  // the wait's own timeout (mirrors real herdr).
}

export class StubHerdrServer {
  readonly socketPath: string;
  private server: Server | null = null;
  private events: ScriptedEvent[] = [];
  private streamQueue: StreamedChange[] = [];
  private sockets = new Set<Socket>();
  private tmpDir: string;
  private waitAttempts: Record<string, number> = {};
  // Per-connection state: which panes it subscribed to, and which queued
  // changes it has already received (so a re-subscribe does not replay).
  private connState = new Map<Socket, { watched: Set<string>; delivered: Set<number> }>();

  constructor(opts: StubServerOptions = {}) {
    this.tmpDir = mkdtempSync(join(tmpdir(), "herdr-stub-"));
    this.socketPath = join(this.tmpDir, "herdr.sock");
    this.events = [...(opts.events ?? [])];
  }

  script(events: ScriptedEvent[]): void {
    this.events = events;
  }

  // Append changes to the stream queue. Each subscriber gets every change
  // whose pane it subscribed to, exactly once (delivery is tracked per
  // connection so a re-subscribe for a new pane does not replay old ones).
  stream(changes: StreamedChange[]): void {
    for (const c of changes) this.streamQueue.push(c);
    // Re-evaluate delivery for every live connection (a stream() call after a
    // re-subscribe must reach the new pane).
    for (const socket of this.sockets) this.deliverQueued(socket);
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
    this.connState.set(socket, { watched: new Set(), delivered: new Set() });
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
      delivered: new Set<number>(),
    };
    // pane.created subscriptions carry no pane_id; we key them on the type so
    // pushPaneCreated can find subscribers. pane-scoped subscriptions key on
    // the pane_id.
    for (const s of subs) state.watched.add(s.pane_id ?? s.type);
    this.connState.set(socket, state);
    socket.write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
    this.deliverQueued(socket);
  }

  // Push every queued change whose pane this connection now watches, marking
  // each delivered so a later re-subscribe does not replay it.
  private deliverQueued(socket: Socket): void {
    const state = this.connState.get(socket);
    if (!state) return;
    this.streamQueue.forEach((change, idx) => {
      if (state.delivered.has(idx)) return;
      if (!state.watched.has(change.paneId)) return;
      state.delivered.add(idx);
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
        from_seq?: number;
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
    if (req.method !== "events.wait") return;

    const paneId = req.params.match_event?.pane_id ?? "";
    const statuses = req.params.match_event?.agent_status ?? [];
    const fromSeq = req.params.from_seq;

    this.waitAttempts[paneId] = (this.waitAttempts[paneId] ?? 0) + 1;
    const attempt = this.waitAttempts[paneId];

    const due = this.events.find(
      (e) =>
        e.paneId === paneId &&
        statuses.includes(e.status) &&
        (fromSeq === undefined || e.seq > fromSeq) &&
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
