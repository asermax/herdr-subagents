import {
  STATUS_KEY,
  createLineSplitter,
  createParentRoleState,
  processLine,
  type StatusSink,
  type WakeSender,
} from "../../core/fleet.js";

// Parent-side role of the herdr-subagents Claude mod: the same bridge as the pi
// extension's parent-role.ts, bound to a hooks module's engine through `Host`
// so it runs under vitest without one. It keeps `helper watch` running for the
// session, mirrors the fleet into the status line, and turns each wake into a
// prompt that starts a turn once the session is idle.

export interface WatchChunk {
  stream: "stdout" | "stderr";
  text: string;
}

/** The slice of the engine the parent role uses; register.ts builds it from `$`. */
export interface Host {
  /** Starts `helper watch`; the stream ends when the process exits. */
  watch: () => AsyncIterable<WatchChunk>;
  status: (text: string | undefined) => void;
  /** Resolves once the prompt has started its turn. */
  submit: (text: string) => Promise<unknown>;
  after: (ms: number, fn: () => void) => { cancel: () => void };
}

const RESTART_DELAY_MS = 2000;

/**
 * Serializes wakes into prompts. A submitted prompt cannot be withdrawn and
 * waits for the session to go idle, so while one is queued every later wake
 * folds into the next prompt instead of queueing a turn of its own.
 */
export const createWakeQueue = (submit: Host["submit"]): ((text: string) => void) => {
  let pending: string[] = [];
  let inFlight = false;

  const flush = async (): Promise<void> => {
    if (inFlight || pending.length === 0) return;

    inFlight = true;
    const text = pending.join("\n");
    pending = [];

    try {
      await submit(text);
    } catch {
      // A refused prompt loses this wake only; `list` stays the backstop.
    } finally {
      inFlight = false;
      void flush();
    }
  };

  return (text) => {
    pending.push(text);
    void flush();
  };
};

/** Starts the parent role; the returned function stops it for good. */
export const startParentRole = (host: Host): (() => void) => {
  const state = createParentRoleState();
  const wake = createWakeQueue(host.submit);

  const sink: StatusSink = {
    setWidget: (_key, content) => host.status(content?.join("\n")),
  };
  const sendWake: WakeSender = (message) => wake(message.content);

  let stopped = false;
  let restart: { cancel: () => void } | undefined;
  let current: AsyncIterator<WatchChunk> | undefined;

  // A dead watcher clears the tracked set: the restarted watch re-seeds the
  // live children from the registry, and anything that closed while the
  // watcher was down must not linger on the status line.
  const run = async (): Promise<void> => {
    try {
      const onChunk = createLineSplitter((line) => processLine(state, sink, sendWake, line));

      current = host.watch()[Symbol.asyncIterator]();

      for (let next = await current.next(); !next.done; next = await current.next()) {
        if (next.value.stream === "stdout") onChunk(next.value.text);
      }
    } catch {
      // A watch that cannot start is retried like one that exited.
    }

    if (stopped) return;

    state.children.clear();
    sink.setWidget(STATUS_KEY, undefined);
    restart = host.after(RESTART_DELAY_MS, () => void run());
  };

  void run();

  return () => {
    stopped = true;
    restart?.cancel();
    // Ending the stream is what kills the watch process.
    void current?.return?.();
    host.status(undefined);
  };
};
