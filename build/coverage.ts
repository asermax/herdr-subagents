import { TOKEN_PATTERN } from "./tokens.ts";
import type { TokenName, TokenMap } from "./tokens.ts";

export class TokenNotConsumedError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(
      `Token {{${token}}} is defined in the harness map but appears nowhere in source.`,
    );
    this.name = "TokenNotConsumedError";
    this.token = token;
  }
}

export class UncoveredPlaceholderError extends Error {
  readonly token: string;

  constructor(token: string) {
    super(
      `Placeholder {{${token}}} appears in source but is not in the harness map.`,
    );
    this.name = "UncoveredPlaceholderError";
    this.token = token;
  }
}

function placeholdersIn(text: string): Set<string> {
  return new Set([...text.matchAll(TOKEN_PATTERN)].map((m) => m[1]!));
}

/**
 * Assert token coverage in both directions (spec §9):
 *  - every token the map defines is consumed somewhere in source (map -> source);
 *  - every placeholder in source is in the map (source -> map).
 *
 * `sources` is the union of file contents that will be substituted under one
 * harness map. `map` is that harness's per-harness token map.
 */
export function assertCoverage(sources: readonly string[], map: TokenMap): void {
  const inSource = new Set<string>();
  for (const text of sources) {
    for (const name of placeholdersIn(text)) {
      inSource.add(name);
    }
  }

  const inMap = new Set<string>(Object.keys(map) as TokenName[]);

  for (const name of inMap) {
    if (!inSource.has(name)) {
      throw new TokenNotConsumedError(name);
    }
  }

  for (const name of inSource) {
    if (!inMap.has(name)) {
      throw new UncoveredPlaceholderError(name);
    }
  }
}
