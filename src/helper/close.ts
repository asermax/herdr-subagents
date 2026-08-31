import type { HerdrClient } from "./herdr-types.js";
import type { ListedChild, RegistryEntry } from "./registry.js";
import type { ChildWorktree } from "./spawn.js";

// Closing a child is the parent's only disposal verb, worktrees included: there
// is deliberately no command for removing one. A worktree outlives its children
// until the last leaves, and that last close takes the checkout with it.

export interface CloseResult {
  tab_id: string;
  closed: true;
  // Set when this close also disposed the child's worktree. The branch survives
  // regardless — it is what the parent reports to the human.
  worktree_removed?: ChildWorktree;
}

// The slice of Registry that close drives.
export interface CloseTracking {
  list(): Promise<ListedChild[]>;
  add(entry: RegistryEntry): Promise<void>;
  remove(paneId: string): Promise<void>;
}

export interface CloseDeps {
  client: HerdrClient;
  registry: CloseTracking;
}

export async function closeChild(tabId: string, deps: CloseDeps): Promise<CloseResult> {
  const { client, registry } = deps;

  const tracked = (await registry.list()).filter((c) => c.tab_id === tabId);
  const child = tracked.find((c) => c.worktree !== undefined);

  // Count herdr's live tabs, not registry entries. A tab the human opened in
  // the checkout keeps the count above one: their work survives, at the cost of
  // the worktree lingering until they close it. That is the safe way to be
  // wrong.
  const lastOut =
    child !== undefined && (await client.workspaceGet(child.workspace_id))?.tab_count === 1;

  // Untrack BEFORE closing: the event-driven watch reads the registry when a
  // child's subscription dies (the close kills it) to tell a deliberate close
  // (no wake) from an unexpected loss (a wake). Registry-first makes that
  // race-free.
  for (const c of tracked) await registry.remove(c.pane_id);

  if (lastOut && child !== undefined) {
    try {
      // Disposes the checkout, the workspace, and this tab together.
      await client.worktreeRemove(child.workspace_id);
      return {
        tab_id: tabId,
        closed: true,
        ...(child.worktree !== undefined ? { worktree_removed: child.worktree } : {}),
      };
    } catch (e) {
      // Nothing was removed — herdr refuses a dirty checkout rather than
      // discarding the work. The child is still alive and still needs tracking,
      // so put it back and let the parent decide what to do about the changes.
      await registry.add(stripListing(child));
      throw e;
    }
  }

  await client.tabClose(tabId);
  return { tab_id: tabId, closed: true };
}

// `list` decorates entries with liveness; the stored shape must not carry it.
function stripListing(child: ListedChild): RegistryEntry {
  const { stale: _stale, ...entry } = child;
  return entry;
}
