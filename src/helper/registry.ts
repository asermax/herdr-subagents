import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot, AgentStatus } from "./herdr-types.js";

// The registry: the helper's record of the children a parent has spawned,
// keyed on pane_id. Pane/workspace ids do not survive a herdr restart, so the
// registry liveness check probes herdr on read rather than trusting the stored
// ids. `list` must not present stale entries as live.

export interface RegistryEntry {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label: string;
  agent: string;
  kind: "pi" | "claude";
  agent_name: string;
  // May be stale; `list` refreshes it.
  status: AgentStatus;
  // The last `state_change_seq` the parent has been told about: set by `prompt`
  // (the delivery receipt), `collect` (the state it read), and `wait` (what it
  // reported). `wait` uses it as its baseline, so a turn that finishes before
  // the wait arms is still a wake instead of a hang (ADR-0008).
  acked_seq?: number;
  // The status at that sequence, when it matters: a parent last told `blocked`
  // must also be woken when the child RESUMES, which is the one case where
  // `working` is a wake.
  acked_status?: AgentStatus;
  // Set when the child was spawned into a git worktree. `close` reads it to
  // decide whether this child is the last one out of the checkout.
  worktree?: { path: string; branch?: string };
  // Wall-clock spawn time. A freshly-spawned child briefly answers
  // `agent_not_found` while its harness boots (no agent detected yet), so `list`
  // must not read that as a dead pane and prune it.
  spawned_at?: number;
}

export interface ListedChild extends RegistryEntry {
  // `true` when the pane no longer resolves in herdr (renumbered after a
  // restart, closed, crashed).
  stale: boolean;
}

export interface RegistryStore {
  read(): Promise<Record<string, RegistryEntry>>;
  write(entries: Record<string, RegistryEntry>): Promise<void>;
  // Serializes a read-modify-write span against OTHER PROCESSES sharing the
  // same backing file. The parent runs helper processes concurrently (pi
  // executes tool calls in parallel), and without this two spawns can each
  // read the same snapshot and the second write loses the first child.
  // Absent on in-memory stores — nothing contends.
  withLock?<T>(run: () => Promise<T>): Promise<T>;
}

// Lock parameters. The wait is bounded: a lock held past the deadline runs the
// operation anyway (best-effort, matching the spawn path's tolerance — a
// registry hiccup must not fail a spawn). Stale takeover covers a holder that
// died between create and unlink.
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, "wx");
    } catch {
      fd = undefined;
    }
    if (fd !== undefined) {
      try {
        return await run();
      } finally {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
      }
    }

    // Taken. Steal it if the holder is long dead, else wait and retry.
    let stolen = false;
    try {
      const st = statSync(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        stolen = true;
      }
    } catch {
      // unreadable — the next acquire attempt is the answer
    }
    if (!stolen) {
      if (Date.now() > deadline) return run();
      await sleep(LOCK_RETRY_MS);
    }
  }
}

// Readers of the registry include other processes (the watch); rename makes
// each write appear atomically — a reader never sees a truncated file.
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function fileRegistryStore(path?: string): RegistryStore {
  const file = path ?? defaultRegistryPath();
  const lockPath = `${file}.lock`;
  return {
    async read() {
      if (!existsSync(file)) return {};
      try {
        const raw = readFileSync(file, "utf8");
        return JSON.parse(raw) as Record<string, RegistryEntry>;
      } catch {
        return {};
      }
    },
    async write(entries) {
      mkdirSync(dirname(file), { recursive: true });
      atomicWrite(file, JSON.stringify(entries, null, 2));
    },
    withLock(run) {
      return withFileLock(lockPath, run);
    },
  };
}

function defaultRegistryPath(): string {
  const base = process.env.HERDR_REGISTRY_PATH;
  if (base) return base;
  const parentPane = process.env.HERDR_PANE_ID ?? "orphan";
  return join(homedir(), ".cache", "herdr-subagents", "registry", `${parentPane}.json`);
}

// How long after spawn a child may answer `agent_not_found` without `list`
// reading it as a dead pane: a booting harness is undetected for a few
// seconds, and the probe cannot tell that apart from a gone pane.
const SPAWN_GRACE_MS = 60_000;

export class Registry {
  constructor(
    private readonly store: RegistryStore,
    private readonly probe: (paneId: string) => Promise<AgentSnapshot | null>,
  ) {}

  // Read-modify-write guard: setStatus (watch) and add (spawn) land
  // concurrently; without serialization, overlapping reads lose a change. A
  // promise-chain lock — each op awaits the previous tail — is enough.
  private chain: Promise<void> = Promise.resolve();

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.chain.then(run);
    // A failing op must not break the next: keep the chain always-settled.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // The whole read-modify-write runs under the store's cross-process lock when
  // it has one; `serialized` alone cannot help — pi executes tool calls in
  // parallel, so two helper processes mutate the same file concurrently.
  private critical<T>(run: () => Promise<T>): Promise<T> {
    return this.serialized(() => (this.store.withLock ?? passthrough)(run));
  }

  async add(entry: RegistryEntry): Promise<void> {
    return this.critical(async () => {
      const entries = await this.store.read();
      entries[entry.pane_id] = entry;
      await this.store.write(entries);
    });
  }

  async get(paneId: string): Promise<RegistryEntry | null> {
    const entries = await this.store.read();
    return entries[paneId] ?? null;
  }

  async setStatus(paneId: string, status: AgentStatus): Promise<void> {
    return this.critical(async () => {
      const entries = await this.store.read();
      if (entries[paneId]) {
        entries[paneId].status = status;
        await this.store.write(entries);
      }
    });
  }

  async setAcked(paneId: string, seq: number, status?: AgentStatus): Promise<void> {
    return this.critical(async () => {
      const entries = await this.store.read();
      const entry = entries[paneId];
      if (entry) {
        entry.acked_seq = seq;
        if (status === undefined) delete entry.acked_status;
        else entry.acked_status = status;
        await this.store.write(entries);
      }
    });
  }

  async remove(paneId: string): Promise<void> {
    return this.critical(async () => {
      const entries = await this.store.read();
      delete entries[paneId];
      await this.store.write(entries);
    });
  }

  // Lists every tracked child. Each entry is probed against herdr: if the pane
  // no longer resolves, the entry is marked stale and pruned from the store so
  // closed children don't accumulate and waste probe subprocesses on every
  // future list/close. A child inside its spawn grace window is kept even on a
  // null probe — a booting harness answers `agent_not_found` for a few
  // seconds, and pruning it would orphan a live child.
  async list(): Promise<ListedChild[]> {
    const entries = await this.store.read();
    const result: ListedChild[] = [];
    const stale: string[] = [];
    for (const entry of Object.values(entries)) {
      const snap = await this.probe(entry.pane_id);
      if (snap === null) {
        if (entry.spawned_at !== undefined && Date.now() - entry.spawned_at < SPAWN_GRACE_MS) {
          result.push({ ...entry, stale: false });
          continue;
        }
        result.push({ ...entry, stale: true });
        stale.push(entry.pane_id);
      } else {
        result.push({ ...entry, status: snap.agent_status, stale: false });
      }
    }
    if (stale.length > 0) {
      await this.critical(async () => {
        const current = await this.store.read();
        for (const paneId of stale) delete current[paneId];
        await this.store.write(current);
      });
    }
    return result;
  }
}

async function passthrough<T>(run: () => Promise<T>): Promise<T> {
  return run();
}
