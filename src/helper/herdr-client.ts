import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import {
  type AgentSnapshot,
  type AgentStartParams,
  HerdrError,
  type HerdrClient,
  type TabCreateParams,
  type TabCreateResult,
} from "./herdr-types.js";

// The real herdr client. CLI calls go through `herdr`; the event surface uses
// the newline-delimited JSON-RPC socket from HERDR_SOCKET_PATH.
//
// `waitForStatusOverSocket` streams `pane.agent_status_changed` over
// `events.subscribe` and filters stale events client-side: herdr does NOT
// implement `from_seq` filtering on `events.wait` (only the test stub used
// to), so seq filtering must happen here. Streaming lets the wait drain past
// stale replays and resolve on the first genuinely new match.

const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(HERDR_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

// The CLI prints a JSON-RPC envelope: { id, result } on success or
// { id, error: { code, message } } on failure. We unwrap to result or throw.
async function herdr<T>(...args: string[]): Promise<T> {
  const { stdout, stderr, code } = await runCli(args);
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new HerdrError(
      "herdr_empty",
      `herdr ${args.join(" ")} produced no output (exit ${code})`,
      stderr,
    );
  }
  let env: { result?: T; error?: { code: string; message: string } };
  try {
    env = JSON.parse(trimmed);
  } catch {
    // Non-JSON stderr means an unsupported kind or a usage error before the
    // server round-tripped — surface the stderr line.
    const msg = stderr.trim().split("\n")[0] || trimmed;
    throw new HerdrError("herdr_invalid_json", msg, stderr);
  }
  if (env.error) {
    throw new HerdrError(env.error.code, env.error.message, stderr);
  }
  return env.result as T;
}

interface TabCreateResponse {
  root_pane: { pane_id: string; tab_id: string; workspace_id: string };
}

interface AgentResponse {
  agent: RawAgent;
}

interface RawAgent {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  name: string;
  agent: string;
  agent_status: AgentSnapshot["agent_status"];
  agent_session?: AgentSnapshot["agent_session"];
  state_change_seq?: number;
  cwd?: string;
  interactive_ready?: boolean;
}

function toSnapshot(raw: RawAgent): AgentSnapshot {
  const snap: AgentSnapshot = {
    pane_id: raw.pane_id,
    tab_id: raw.tab_id,
    workspace_id: raw.workspace_id,
    name: raw.name,
    agent: raw.agent,
    agent_status: raw.agent_status,
  };
  if (raw.agent_session) snap.agent_session = raw.agent_session;
  if (raw.state_change_seq !== undefined) snap.state_change_seq = raw.state_change_seq;
  if (raw.cwd !== undefined) snap.cwd = raw.cwd;
  if (raw.interactive_ready !== undefined) snap.interactive_ready = raw.interactive_ready;
  return snap;
}

export class RealHerdrClient implements HerdrClient {
  constructor(private readonly socketPath: string) {}

  async tabCreate(params: TabCreateParams): Promise<TabCreateResult> {
    const args = [
      "tab",
      "create",
      "--workspace",
      params.workspaceId,
      "--cwd",
      params.cwd,
      "--label",
      params.label,
      params.focus ? "--focus" : "--no-focus",
    ];
    for (const [k, v] of Object.entries(params.env)) {
      args.push("--env", `${k}=${v}`);
    }
    const res = await herdr<TabCreateResponse>(...args);
    return {
      pane_id: res.root_pane.pane_id,
      tab_id: res.root_pane.tab_id,
      workspace_id: res.root_pane.workspace_id,
    };
  }

  async tabClose(tabId: string): Promise<void> {
    await herdr<{ type: string }>("tab", "close", tabId);
  }

  async agentStart(params: AgentStartParams): Promise<AgentSnapshot> {
    const res = await herdr<AgentResponse>(
      "agent",
      "start",
      params.name,
      "--kind",
      params.kind,
      "--pane",
      params.paneId,
      "--timeout",
      String(params.timeoutMs),
      "--",
      ...params.args,
    );
    return toSnapshot(res.agent);
  }

  async agentGet(target: string): Promise<AgentSnapshot | null> {
    try {
      const res = await herdr<AgentResponse>("agent", "get", target);
      return toSnapshot(res.agent);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "agent_not_found") return null;
      throw e;
    }
  }

  async agentRename(target: string, name: string): Promise<void> {
    await herdr<{ type: string }>("agent", "rename", target, name);
  }

  async agentPrompt(target: string, body: string): Promise<void> {
    await herdr<{ type: string }>("agent", "prompt", target, body);
  }

  async waitForStatus(
    paneId: string,
    statuses: AgentSnapshot["agent_status"][],
    opts: { timeoutMs: number; fromSeq?: number },
  ): Promise<AgentSnapshot> {
    return waitForStatusOverSocket(this.socketPath, paneId, statuses, opts);
  }
}

// Stream-based socket wait. Opens a connection, subscribes to
// `pane.agent_status_changed` for the pane, and resolves with the snapshot
// from the first event whose status is in the target set AND whose
// `state_change_seq` is strictly greater than `fromSeq` (when given). Stale
// events — a replay of the pre-prompt state — are ignored client-side and the
// stream keeps draining; they never close the socket or clear the timer.
//
// This replaces a one-shot `events.wait` that used to send `from_seq` and rely
// on herdr to filter. Real herdr does not implement `from_seq`, so the one-shot
// form cannot keep waiting past a stale reply. The stream form drains until a
// non-stale match resolves (or the timeout fires). Free-standing so the test
// harness drives the same framing.
export function waitForStatusOverSocket(
  socketPath: string,
  paneId: string,
  statuses: AgentSnapshot["agent_status"][],
  opts: { timeoutMs: number; fromSeq?: number },
): Promise<AgentSnapshot> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let buffer = "";
    let settled = false;
    const subId = `wait:${paneId}`;
    const want = new Set<string>(statuses);
    const request = JSON.stringify({
      id: subId,
      method: "events.subscribe",
      params: {
        subscriptions: [
          { type: "pane.agent_status_changed", pane_id: paneId },
        ],
      },
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const cleanup = () => {
      socket?.destroy();
      socket = null;
    };

    const timer = setTimeout(() => {
      finish(() => {
        cleanup();
        reject(new HerdrError("wait_timeout", `no status change for ${paneId}`));
      });
    }, opts.timeoutMs + 500);

    try {
      socket = createConnection(socketPath, () => {
        socket?.write(request + "\n");
      });
    } catch (e) {
      clearTimeout(timer);
      reject(new HerdrError("socket_connect", `cannot open ${socketPath}`, e));
      return;
    }

    socket.on("error", (e) => {
      clearTimeout(timer);
      finish(() => {
        cleanup();
        reject(new HerdrError("socket_error", e.message, e));
      });
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        let env: {
          id?: string;
          result?: { type: string };
          event?: string;
          data?: { agent_status?: AgentSnapshot["agent_status"] } & Partial<AgentSnapshot>;
          error?: { code: string; message: string };
        };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }

        // Error reply to the subscribe request itself.
        if (env.id === subId && env.error) {
          clearTimeout(timer);
          finish(() => {
            cleanup();
            reject(new HerdrError(env.error!.code, env.error!.message));
          });
          return;
        }

        // subscription_started ack — nothing to resolve on.
        if (env.result?.type === "subscription_started") continue;

        if (env.event !== "pane.agent_status_changed") continue;
        const data = env.data;
        if (!data || !data.pane_id || !data.agent_status) continue;
        if (data.pane_id !== paneId) continue;
        if (!want.has(data.agent_status)) continue;

        // Stale check FIRST: a replay of the pre-prompt state (seq <= fromSeq)
        // must not resolve, must not clean up, must not clear the timer. The
        // socket stays open and the stream keeps draining for the next event.
        if (
          opts.fromSeq !== undefined &&
          data.state_change_seq !== undefined &&
          data.state_change_seq <= opts.fromSeq
        ) {
          continue;
        }

        // Genuine non-stale match — resolve and tear down.
        clearTimeout(timer);
        finish(() => {
          cleanup();
          resolve(data as AgentSnapshot);
        });
        return;
      }
    });
  });
}

export function clientFromEnv(): RealHerdrClient {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    throw new HerdrError(
      "missing_socket_path",
      "HERDR_SOCKET_PATH is not set; cannot reach herdr",
    );
  }
  return new RealHerdrClient(socketPath);
}

export function currentWorkspaceId(): string {
  const ws = process.env.HERDR_WORKSPACE_ID;
  if (!ws) {
    throw new HerdrError(
      "missing_workspace",
      "HERDR_WORKSPACE_ID is not set; cannot create child tabs",
    );
  }
  return ws;
}
