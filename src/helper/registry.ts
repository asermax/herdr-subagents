import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  // Last status we observed. May be stale; `list` refreshes it.
  status: AgentStatus;
}

export interface ListedChild extends RegistryEntry {
  // `true` when the pane no longer resolves in herdr (renumbered after a
  // restart, closed, crashed).
  stale: boolean;
}

export interface RegistryStore {
  read(): Promise<Record<string, RegistryEntry>>;
  write(entries: Record<string, RegistryEntry>): Promise<void>;
}

export function fileRegistryStore(path?: string): RegistryStore {
  const file = path ?? defaultRegistryPath();
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
      writeFileSync(file, JSON.stringify(entries, null, 2));
    },
  };
}

function defaultRegistryPath(): string {
  const base = process.env.HERDR_REGISTRY_PATH;
  if (base) return base;
  const parentPane = process.env.HERDR_PANE_ID ?? "orphan";
  return join(homedir(), ".cache", "herdr-subagents", "registry", `${parentPane}.json`);
}

export class Registry {
  constructor(
    private readonly store: RegistryStore,
    private readonly probe: (paneId: string) => Promise<AgentSnapshot | null>,
  ) {}

  async add(entry: RegistryEntry): Promise<void> {
    const entries = await this.store.read();
    entries[entry.pane_id] = entry;
    await this.store.write(entries);
  }

  async get(paneId: string): Promise<RegistryEntry | null> {
    const entries = await this.store.read();
    return entries[paneId] ?? null;
  }

  async setStatus(paneId: string, status: AgentStatus): Promise<void> {
    const entries = await this.store.read();
    if (entries[paneId]) {
      entries[paneId].status = status;
      await this.store.write(entries);
    }
  }

  async remove(paneId: string): Promise<void> {
    const entries = await this.store.read();
    delete entries[paneId];
    await this.store.write(entries);
  }

  // Lists every tracked child. Each entry is probed against herdr: if the pane
  // no longer resolves, the entry is marked stale and never presented as live.
  async list(): Promise<ListedChild[]> {
    const entries = await this.store.read();
    const result: ListedChild[] = [];
    for (const entry of Object.values(entries)) {
      const snap = await this.probe(entry.pane_id);
      if (snap === null) {
        result.push({ ...entry, stale: true });
      } else {
        result.push({ ...entry, status: snap.agent_status, stale: false });
      }
    }
    return result;
  }
}
