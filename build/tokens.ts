/**
 * The token contract. Exactly two substitution tokens exist.
 *
 * `{{wake}}`   — content placeholder for the one model-visible divergence
 *                (pi auto-wakes; claude arms a background wait). Injected from
 *                the per-harness wake fragment at src/skills/delegate/{pi,claude}.md.
 * `{{helper}}` — the helper's absolute path, resolved per artifact root at
 *                build time (the Claude plugin's root variable on claude, the
 *                package directory on pi).
 *
 * The build errors on any `{{...}}` placeholder that is not one of these two,
 * and asserts coverage in both directions against the per-harness map.
 */

/** The two exact token names, without the braces. */
export const TOKENS = ["wake", "helper"] as const;

export type TokenName = (typeof TOKENS)[number];

/** A per-harness map: token name -> replacement value. */
export type TokenMap = Partial<Record<TokenName, string>>;

/** Matches a substitution placeholder: `{{` + name + `}}`. Name is any word. */
export const TOKEN_PATTERN = /\{\{(\w+)\}\}/g;
