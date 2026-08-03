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

/**
 * Replace every `{{...}}` placeholder in `source` with the value from `map`.
 *
 * - Errors on any placeholder whose name is not a known token.
 * - Errors when a known token appears in source but the map omits its value.
 * - Token-free text returns verbatim.
 */
export function substitute(source: string, map: TokenMap): string {
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
