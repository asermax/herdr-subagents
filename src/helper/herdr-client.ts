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
// A tiny per-socket id counter keeps request/response correlated. Subscriptions
// are not needed — we use the one-shot `events.wait`, so each wait opens its
// own connection.

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
  return {
    pane_id: raw.pane_id,
    tab_id: raw.tab_id,
    workspace_id: raw.workspace_id,
    name: raw.name,
    agent: raw.agent,
    agent_status: raw.agent_status,
    agent_session: raw.agent_session,
    state_change_seq: raw.state_change_seq,
    cwd: raw.cwd,
    interactive_ready: raw.interactive_ready,
  };
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

// One-shot socket wait. Opens a connection, sends an `events.wait` request
// matching on `pane_agent_status_changed` for the target statuses, and resolves
// with the snapshot from the event. Re-implemented as a free function so the
// test harness can drive the same framing if needed.
export function waitForStatusOverSocket(
  socketPath: string,
  paneId: string,
  statuses: AgentSnapshot["agent_status"][],
  opts: { timeoutMs: number; fromSeq?: number },
): Promise<AgentSnapshot> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let buffer = "";
    const id = `wait:${paneId}`;
    const request = JSON.stringify({
      id,
      method: "events.wait",
      params: {
        match_event: {
          event: "pane_agent_status_changed",
          pane_id: paneId,
          agent_status: statuses,
        },
        from_seq: opts.fromSeq,
        timeout_ms: opts.timeoutMs,
      },
    });

    const cleanup = () => {
      socket?.destroy();
      socket = null;
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new HerdrError("wait_timeout", `no status change for ${paneId}`));
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
      cleanup();
      reject(new HerdrError("socket_error", e.message, e));
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
          result?: {
            type: string;
            event?: {
              event: string;
              data?: { agent_status?: AgentSnapshot["agent_status"] } & Partial<AgentSnapshot>;
            };
          };
          error?: { code: string; message: string };
        };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        if (env.id !== id) continue;
        clearTimeout(timer);
        cleanup();
        if (env.error) {
          reject(new HerdrError(env.error.code, env.error.message));
          return;
        }
        const data = env.result?.event?.data;
        if (data && data.agent_status && data.pane_id) {
          if (opts.fromSeq !== undefined && data.state_change_seq !== undefined) {
            if (data.state_change_seq <= opts.fromSeq) {
              // stale replay of the pre-prompt state — keep waiting
              return;
            }
          }
          resolve(data as AgentSnapshot);
        } else {
          reject(new HerdrError("wait_no_data", "events.wait returned no data"));
        }
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
