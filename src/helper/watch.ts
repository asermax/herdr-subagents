import { createConnection } from "node:net";
import { fileRegistryStore, type RegistryStore } from "./registry.js";
import { HerdrError } from "./herdr-types.js";

// `watch`: a long-lived stream of child-status changes for the current parent,
// one line of JSON per change. Polls `agent.get` per child on one-shot
// connections and emits only on a change (and once when a child first appears
// or goes gone).
//
// Why poll instead of events.subscribe: herdr's socket allows only ONE
// events.subscribe request per connection (a second resets it), and a
// subscribe to a pane that no longer exists — a stale registry entry from a
// child closed outside `helper close` — resets the connection too. `agent.get`
// on a one-shot connection is robust to both: a gone pane answers
// agent_not_found instead of killing a stream, so the watch polls.
//
// The registry is parent-pane-scoped (~/.cache/herdr-subagents/registry/
// <HERDR_PANE_ID>.json), so a watch only ever sees THIS parent's children.
// Each cycle re-reads it, so children spawned after watch starts appear with
// at most one poll of latency.

export interface WatchLine {
  pane_id: string;
  label: string;
  status: string;
}

export interface WatchDeps {
  store: RegistryStore;
  // Where to write one JSON line per change.
  out?: (line: string) => void;
  // Override the poll interval (ms); defaults to HERDR_WATCH_POLL_MS or 2000.
  pollMs?: number;
}

const DEFAULT_POLL_MS = 2000;

export function watchChildren(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  return pollLoop(socketPath, deps, signal);
}

// The panes to watch come straight from the registry store — watch only needs
// the ids it will probe, plus the label for each line.
async function readPanes(deps: WatchDeps): Promise<{ paneId: string; label: string }[]> {
  const entries = await deps.store.read();
  return Object.values(entries).map((e) => ({ paneId: e.pane_id, label: e.label }));
}

// One-shot agent.get on its own connection. Returns the current status, or
// null if the pane is gone (stale registry entry / closed child).
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

// One poll cycle: probe every registered child, emit a line for each new or
// changed status, and one `gone` for each tracked child no longer live.
// Mutates `last` to the live set. Exposed so tests run a single deterministic
// cycle instead of timing the poll loop.
export async function pollOnce(
  socketPath: string,
  deps: WatchDeps,
  last: Map<string, { label: string; status: string }>,
): Promise<void> {
  const write = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const panes = await readPanes(deps);
  const live = new Map<string, { label: string; status: string }>();
  for (const p of panes) {
    const status = await probeAgent(socketPath, p.paneId);
    if (status) live.set(p.paneId, { label: p.label, status });
  }

  // A previously-live child that is no longer live left the fleet this
  // cycle. Two causes, distinguished by whether it is still in the registry:
  //   - still tracked, but the probe failed (crashed, or herdr renumbered
  //     panes on restart) → `gone`: unexpected, so the consumer wakes.
  //   - removed from the registry (the parent ran `helper close`) → `closed`:
  //     deliberate, so the consumer drops it from the widget WITHOUT waking.
  const trackedIds = new Set(panes.map((p) => p.paneId));
  for (const [paneId, info] of last) {
    if (live.has(paneId)) continue;
    const status = trackedIds.has(paneId) ? "gone" : "closed";
    write(JSON.stringify({ pane_id: paneId, label: info.label, status }));
  }
  // New or changed statuses only — repeating a stable status would re-wake the
  // parent every cycle while a child sits terminal.
  for (const [paneId, info] of live) {
    const prev = last.get(paneId);
    if (!prev || prev.status !== info.status) {
      write(JSON.stringify({ pane_id: paneId, label: info.label, status: info.status }));
    }
  }

  last.clear();
  for (const [paneId, info] of live) last.set(paneId, info);
}

async function pollLoop(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  const pollMs = deps.pollMs ?? (Number(process.env.HERDR_WATCH_POLL_MS) || DEFAULT_POLL_MS);
  const last = new Map<string, { label: string; status: string }>();
  while (!signal?.aborted) {
    await pollOnce(socketPath, deps, last);
    if (signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, pollMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    });
  }
}

// Convenience for the CLI: builds the registry store from the environment
// and runs watch against the env-configured socket.
export async function runWatch(): Promise<void> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) {
    throw new HerdrError(
      "missing_socket_path",
      "HERDR_SOCKET_PATH is not set; cannot reach herdr",
    );
  }
  const store = fileRegistryStore();
  await watchChildren(socketPath, { store });
}
