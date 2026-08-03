import { TOKEN_PATTERN } from "./tokens.ts";
import type { TokenName, TokenMap } from "./tokens.ts";

export class UnknownTokenError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`Unknown substitution token ${token}. Known tokens: {{wake}}, {{helper}}.`);
    this.name = "UnknownTokenError";
    this.token = token;
  }
}

export class MissingTokenValueError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(`No value supplied for token {{${token}}} in the harness map.`);
    this.name = "MissingTokenValueError";
    this.token = token;
  }
}

export class TokenNotConvergedError extends Error {
  constructor(remaining: string) {
    super(
      `Substitution did not reach a fixpoint; a token value likely references itself. Remaining placeholder: ${remaining}`,
    );
    this.name = "TokenNotConvergedError";
  }
}

function substituteOnce(source: string, map: TokenMap): string {
  return source.replace(TOKEN_PATTERN, (full, name: string) => {
    if (name !== "wake" && name !== "helper") {
      throw new UnknownTokenError(full);
    }

    const value = map[name as TokenName];
    if (value === undefined) {
      throw new MissingTokenValueError(name);
    }

    return value;
  });
}

/**
 * Replace every `{{...}}` placeholder in `source` with the value from `map`.
 *
 * - Errors on any placeholder whose name is not a known token.
 * - Errors when a known token appears in source but the map omits its value.
 * - Token-free text returns verbatim.
 *
 * Iterates to a fixpoint because a token's value may itself contain a token —
 * the wake fragment (the value of `{{wake}}`) references `{{helper}}`. Bounded
 * to one pass per known token; a non-converging map (a value referencing its
 * own token) raises TokenNotConvergedError rather than looping forever.
 */
export function substitute(source: string, map: TokenMap): string {
  const maxPasses = 1 + Object.keys(map).length;
  let out = source;
  for (let pass = 0; pass < maxPasses; pass++) {
    const next = substituteOnce(out, map);
    if (next === out) return next;
    out = next;
  }

  const leftover = out.match(TOKEN_PATTERN)?.[0] ?? "";
  throw new TokenNotConvergedError(leftover);
}
