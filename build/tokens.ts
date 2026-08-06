/**
 * The token contract. Exactly three substitution tokens exist.
 *
 * `{{wake}}`    — content placeholder for the wake divergence (pi auto-wakes;
 *                 claude arms a background wait). Injected from the per-harness
 *                 wake fragment at src/skills/delegate/{pi,claude}.md.
 * `{{helper}}`  — the helper's absolute path, resolved per artifact root at
 *                 build time (the Claude plugin's root variable on claude, the
 *                 package directory on pi). Consumed inside the claude invoke
 *                 fragment; absent from the pi invoke fragment (pi uses a tool).
 * `{{invoke}}`  — content placeholder for the command-invocation divergence
 *                 (pi uses the `subagent` tool; claude uses bash). Injected
 *                 from the per-harness invoke fragment at
 *                 src/skills/delegate/invoke-{pi,claude}.md.
 *
 * The build errors on any `{{...}}` placeholder that is not one of these three,
 * and asserts coverage in both directions against the per-harness map.
 */

/** The three exact token names, without the braces. */
export const TOKENS = ["wake", "helper", "invoke"] as const;

export type TokenName = (typeof TOKENS)[number];

/** A per-harness map: token name -> replacement value. */
export type TokenMap = Partial<Record<TokenName, string>>;

/** Matches a substitution placeholder: `{{` + name + `}}`. Name is any word. */
export const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;
