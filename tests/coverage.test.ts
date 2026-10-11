import { describe, it, expect } from "vitest";
import {
  assertCoverage,
  TokenNotConsumedError,
  UncoveredPlaceholderError,
} from "../build/coverage.ts";

describe("assertCoverage", () => {
  it("passes when source placeholders and the map agree exactly", () => {
    expect(() => assertCoverage(["call {{invoke}}"], { invoke: "i" })).not.toThrow();
  });

  it("passes when a token is consumed in one of several source files", () => {
    const sources = ["no tokens here", "{{invoke}} lives here"];
    expect(() => assertCoverage(sources, { invoke: "i" })).not.toThrow();
  });

  it("passes when source has no tokens and the map is empty", () => {
    expect(() => assertCoverage(["plain text"], {})).not.toThrow();
  });

  it("fails map -> source: a map token no source consumes", () => {
    expect(() => assertCoverage(["no tokens here"], { invoke: "i" })).toThrow(
      TokenNotConsumedError,
    );
  });

  it("fails source -> map: a source placeholder the map does not define", () => {
    expect(() => assertCoverage(["{{invoke}}"], {})).toThrow(UncoveredPlaceholderError);
  });

  it("fails source -> map on an unknown placeholder spelling", () => {
    // Map is empty so the only failure is the source placeholder `{{invok}}`,
    // which is not a known token and is not in the map.
    expect(() => assertCoverage(["a typo: {{invok}}"], {})).toThrow(UncoveredPlaceholderError);
  });
});
