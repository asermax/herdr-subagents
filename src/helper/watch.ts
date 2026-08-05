import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { fileRegistryStore, type RegistryStore } from "./registry.js";
import { HerdrError } from "./herdr-types.js";

// `watch`: a long-lived stream of status changes for every registered child,
// one line of JSON per change. Speaks herdr's socket directly — agent state is
// push, not polled, and there is no CLI for it.
//
// Reads the registry to know which children to watch. This is the link:
// the model spawns over bash, so the extension never sees
// the call — `helper watch` (reading the registry) is what the extension
// forwards, and the helper stays the only herdr socket client.
//
// herdr's pane.agent_status_changed subscription requires a pane_id (no
// wildcard), so a subscribe-once-at-startup would miss children spawned later.
// We also subscribe to pane.created (workspace-wide) and, on a create event,
// re-read the registry and subscribe to any new children. The registry is
// still the source of truth for WHICH children are tracked — pane.created only
// triggers a re-read. pane.closed (also workspace-wide) drops a closed child
// from the tracked set so events for it stop forwarding.

export interface WatchLine {
  pane_id: string;
  label: string;
  status: string;
}

export interface WatchDeps {
  store: RegistryStore;
  // Where to write one JSON line per change.
  out?: (line: string) => void;
}

// Subscribes to pane.agent_status_changed for every tracked child and streams
// changes until the socket closes or an abort signal fires. Rejects on socket
// error. Also subscribes to pane.created so children registered after watch
// starts are picked up.
export function watchChildren(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  return subscribe(socketPath, deps, signal);
}

// The panes to watch come straight from the registry store — watch only needs
// the ids it will subscribe to, plus the label for each line. It does NOT
// probe herdr per pane (that is `list`'s job); a stale entry just yields no
// events from herdr.
async function readPanes(deps: WatchDeps): Promise<{ paneId: string; label: string }[]> {
  const entries = await deps.store.read();
  return Object.values(entries).map((e) => ({ paneId: e.pane_id, label: e.label }));
}

function subscribe(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  const write = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const labels = new Map<string, string>();
  const subscribed = new Set<string>();
  // Pending agent.get probes: probe-id -> { paneId, label }. The
  // status-change subscription emits only CHANGES, so on subscribe we probe
  // each child's current status and emit it — otherwise a spawned child never
  // reaches the footer until a change happens to fire (routinely missed).
  const pendingProbes = new Map<string, { paneId: string; label: string }>();
  let socket: Socket | null = null;
  let buffer = "";
  let reqId = 0;

  const sendSubscribe = (panes: { paneId: string; label: string }[]): void => {
    if (!socket || panes.length === 0) return;
    for (const p of panes) {
      labels.set(p.paneId, p.label);
      subscribed.add(p.paneId);
    }
    const request = JSON.stringify({
      id: `sub:${reqId++}`,
      method: "events.subscribe",
      params: {
        subscriptions: panes.map((p) => ({
          type: "pane.agent_status_changed",
          pane_id: p.paneId,
        })),
      },
    });
    socket.write(request + "\n");
    // Probe each child's current status: the subscription above emits only
    // changes, so without this a newly subscribed child contributes nothing
    // until its next transition (often missed entirely).
    for (const p of panes) {
      const id = `get:${reqId++}`;
      pendingProbes.set(id, { paneId: p.paneId, label: p.label });
      socket.write(
        JSON.stringify({ id, method: "agent.get", params: { target: p.paneId } }) + "\n",
      );
    }
  };

  // On a pane.created event, re-read the registry and subscribe to any child
  // we are not yet watching. The registry decides what is tracked.
  const onPaneCreated = async (): Promise<void> => {
    const panes = await readPanes(deps);
    const fresh = panes.filter((p) => !subscribed.has(p.paneId));
    if (fresh.length > 0) sendSubscribe(fresh);
  };

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket?.destroy();
      socket = null;
    };

    if (signal) {
      const onAbort = () => {
        cleanup();
        resolve();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      socket = createConnection(socketPath, async () => {
        // Always subscribe to pane.created/closed (workspace-wide) so children
        // registered after watch starts are picked up and closed ones are
        // dropped. Plus the initial set.
        const initial = await readPanes(deps);
        sendSubscribe(initial);
        socket?.write(
          JSON.stringify({
            id: `sub:${reqId++}`,
            method: "events.subscribe",
            params: { subscriptions: [{ type: "pane.created" }, { type: "pane.closed" }] },
          }) + "\n",
        );
      });
    } catch (e) {
      reject(new HerdrError("socket_connect", `cannot open ${socketPath}`, e));
      return;
    }

    socket.on("error", (e) => {
      cleanup();
      reject(new HerdrError("socket_error", e.message, e));
    });

    socket.on("close", () => {
      socket = null;
      resolve();
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
          result?: { type: string; agent?: { agent_status?: string } };
          event?: string;
          data?: { pane_id?: string; agent_status?: string };
        };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        // An agent.get probe response: emit the child's current status so the
        // footer seeds immediately on subscribe. Skip if the child was closed
        // before the response landed (no longer tracked).
        if (env.id && pendingProbes.has(env.id)) {
          const { paneId, label } = pendingProbes.get(env.id)!;
          pendingProbes.delete(env.id);
          const status = env.result?.agent?.agent_status;
          if (status && labels.has(paneId)) {
            write(JSON.stringify({ pane_id: paneId, label, status }));
          }
          continue;
        }
        if (env.result?.type === "subscription_started") continue;
        if (env.event === "pane.created") {
          void onPaneCreated();
          continue;
        }
        if (env.event === "pane.closed") {
          const closed = env.data?.pane_id;
          if (closed) {
            // Drop the closed child: stop forwarding its events. If its pane
            // id is reused after a restart, pane.created re-reads the registry
            // and re-subscribes under the new child's label.
            subscribed.delete(closed);
            labels.delete(closed);
          }
          continue;
        }
        if (env.event !== "pane.agent_status_changed") continue;
        const data = env.data;
        if (!data?.pane_id || !data.agent_status) continue;
        // Only emit for children we subscribed to — the registry is the source
        // of truth, and a pane we never subscribed to should not leak in.
        if (!labels.has(data.pane_id)) continue;
        const out: WatchLine = {
          pane_id: data.pane_id,
          label: labels.get(data.pane_id) ?? "",
          status: data.agent_status,
        };
        write(JSON.stringify(out));
      }
    });
  });
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
