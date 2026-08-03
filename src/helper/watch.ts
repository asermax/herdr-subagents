import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { fileRegistryStore, type RegistryStore } from "./registry.js";
import { HerdrError } from "./herdr-types.js";

// `watch`: a long-lived stream of status changes for every registered child,
// one line of JSON per change. Speaks herdr's socket directly — agent state is
// push, not polled, and there is no CLI for it (spec §3, §5).
//
// Reads the registry to know which children to watch. This is the link the
// spec's §5 calls out: the model spawns over bash, so the extension never sees
// the call — `helper watch` (reading the registry) is what the extension
// forwards, and the helper stays the only herdr socket client.

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
// error. Resolves immediately when the registry has no children to watch.
export function watchChildren(
  socketPath: string,
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  return readPanes(deps).then((paneIds) => {
    if (paneIds.length === 0) return;
    return subscribe(socketPath, paneIds, deps, signal);
  });
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
  panes: { paneId: string; label: string }[],
  deps: WatchDeps,
  signal?: AbortSignal,
): Promise<void> {
  const write = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const labels = new Map(panes.map((p) => [p.paneId, p.label]));
  let socket: Socket | null = null;
  let buffer = "";

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
      socket = createConnection(socketPath, () => {
        const request = JSON.stringify({
          id: "sub",
          method: "events.subscribe",
          params: {
            subscriptions: panes.map((p) => ({
              type: "pane.agent_status_changed",
              pane_id: p.paneId,
            })),
          },
        });
        socket?.write(request + "\n");
      });
    } catch (e) {
      reject(
        new HerdrError("socket_connect", `cannot open ${socketPath}`, e),
      );
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
          result?: { type: string };
          event?: string;
          data?: { pane_id?: string; agent_status?: string };
        };
        try {
          env = JSON.parse(line);
        } catch {
          continue;
        }
        // The subscription_started ack — nothing to emit.
        if (env.result?.type === "subscription_started") continue;
        if (env.event !== "pane.agent_status_changed") continue;
        const data = env.data;
        if (!data?.pane_id || !data.agent_status) continue;
        // Only emit for children we subscribed to — a stray event for an
        // unregistered pane never arrives, but the filter keeps us honest.
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
