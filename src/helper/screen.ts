import type { HerdrClient } from "./herdr-types.js";

// How much of the pane to read back. A startup dialog or a tool-approval
// prompt fits well inside this; more would bury it in scrollback.
export const DEFAULT_SCREEN_LINES = 40;

/**
 * Read a pane's screen, best-effort. Used to show the parent what a blocked
 * child is waiting on. Every caller is already reporting something else (a
 * spawn failure, an unblock result), so a failed read must never replace that
 * report with its own error — it just yields no screen.
 */
export async function readScreen(
  client: HerdrClient,
  paneId: string,
  lines = DEFAULT_SCREEN_LINES,
): Promise<string | undefined> {
  try {
    const screen = await client.agentRead(paneId, { lines });
    return screen.trim() === "" ? undefined : screen;
  } catch {
    return undefined;
  }
}

/**
 * Read a pane's recent output, best-effort, without needing an agent on the
 * pane — what a harness printed before exiting. Same failure discipline as
 * readScreen: a failed read yields nothing rather than its own error.
 */
export async function readPaneOutput(
  client: HerdrClient,
  paneId: string,
  lines = DEFAULT_SCREEN_LINES,
): Promise<string | undefined> {
  try {
    const screen = await client.paneRead(paneId, { lines });
    return screen.trim() === "" ? undefined : screen;
  } catch {
    return undefined;
  }
}
