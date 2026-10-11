import { describe, it, expect } from "vitest";
import {
  substitute,
  UnknownTokenError,
  MissingTokenValueError,
  TokenNotConvergedError,
} from "../build/substitute.ts";

describe("substitute", () => {
  it("substitutes {{invoke}} from the per-harness map", () => {
    const out = substitute("Commands: {{invoke}}", { invoke: "Use the subagent tool." });
    expect(out).toBe("Commands: Use the subagent tool.");
  });

  it("returns token-free text verbatim", () => {
    const text = "# A normal heading\n\nNo tokens here, not even {{ brace noise.";
    expect(substitute(text, {})).toBe(text);
  });

  it("returns token-free text verbatim even with an empty map", () => {
    const text = "just plain markdown";
    expect(substitute(text, {})).toBe(text);
  });

  it("errors on an unknown token (no silent passthrough)", () => {
    const source = "This misspells it: {{invok}}";
    expect(() => substitute(source, { invoke: "x" })).toThrow(UnknownTokenError);
    try {
      substitute(source, { invoke: "x" });
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTokenError);
      expect((err as UnknownTokenError).token).toBe("{{invok}}");
    }
  });

  it("errors on a retired token", () => {
    expect(() => substitute("{{wake}}", { invoke: "x" })).toThrow(UnknownTokenError);
    expect(() => substitute("{{helper}}", { invoke: "x" })).toThrow(UnknownTokenError);
  });

  it("errors when a known token appears in source but the map omits its value", () => {
    expect(() => substitute("{{invoke}}", {})).toThrow(MissingTokenValueError);
  });

  it("substitutes when a token repeats within the source", () => {
    expect(substitute("{{invoke}} and {{invoke}}", { invoke: "t" })).toBe("t and t");
  });

  it("errors when a token value references its own token (no fixpoint)", () => {
    expect(() => substitute("{{invoke}}", { invoke: "loop {{invoke}}" })).toThrow(
      TokenNotConvergedError,
    );
  });
});
