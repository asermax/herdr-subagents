/**
 * The token contract. Exactly one substitution token exists.
 *
 * `{{invoke}}` — content placeholder for the command-invocation divergence
 *                (the `subagent` tool's commands differ per harness). Injected
 *                from the per-harness invoke fragment at
 *                src/skills/delegate/invoke-{pi,claude}.md.
 *
 * The build errors on any `{{...}}` placeholder that is not this one, and
 * asserts coverage in both directions against the per-harness map.
 */

/** The exact token names, without the braces. */
export const TOKENS = ["invoke"] as const;

export type TokenName = (typeof TOKENS)[number];

/** A per-harness map: token name -> replacement value. */
export type TokenMap = Partial<Record<TokenName, string>>;

/** Matches a substitution placeholder: `{{` + name + `}}`. Name is any word. */
export const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;
