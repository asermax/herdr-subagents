import { describe, it, expect } from "vitest";
import {
  assertCoverage,
  TokenNotConsumedError,
  UncoveredPlaceholderError,
} from "../build/coverage.ts";

describe("assertCoverage", () => {
  it("passes when source placeholders and the map agree exactly", () => {
    const sources = ["arm {{wake}}", "call {{helper}}"];
    expect(() =>
      assertCoverage(sources, { wake: "w", helper: "/h" }),
    ).not.toThrow();
  });

  it("passes when a token is consumed in one of several source files", () => {
    const sources = ["no tokens here", "{{wake}} lives here"];
    expect(() =>
      assertCoverage(sources, { wake: "w" }),
    ).not.toThrow();
  });

  it("passes when source has no tokens and the map is empty", () => {
    expect(() => assertCoverage(["plain text"], {})).not.toThrow();
  });

  it("fails map -> source: a map token no source consumes", () => {
    const sources = ["only {{wake}} here"];
    expect(() =>
      assertCoverage(sources, { wake: "w", helper: "/h" }),
    ).toThrow(TokenNotConsumedError);
  });

  it("fails source -> map: a source placeholder the map does not define", () => {
    const sources = ["{{wake}} and {{helper}}"];
    expect(() => assertCoverage(sources, { wake: "w" })).toThrow(
      UncoveredPlaceholderError,
    );
  });

  it("fails source -> map on an unknown placeholder spelling", () => {
    // Map is empty so the only failure is the source placeholder `{{wak}}`, which
    // is not a known token and is not in the map.
    const sources = ["a typo: {{wak}}"];
    expect(() => assertCoverage(sources, {})).toThrow(
      UncoveredPlaceholderError,
    );
  });
});
