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
  private sockets = new Set<Socket>();
  private tmpDir: string;
  private waitAttempts: Record<string, number> = {};

  constructor(opts: StubServerOptions = {}) {
    this.tmpDir = mkdtempSync(join(tmpdir(), "herdr-stub-"));
    this.socketPath = join(this.tmpDir, "herdr.sock");
    this.events = [...(opts.events ?? [])];
  }

  script(events: ScriptedEvent[]): void {
    this.events = events;
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
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
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
        from_seq?: number;
        timeout_ms?: number;
      };
    };
    try {
      req = JSON.parse(raw);
    } catch {
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
