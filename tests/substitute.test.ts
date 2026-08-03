import { describe, it, expect } from "vitest";
import {
  substitute,
  UnknownTokenError,
  MissingTokenValueError,
} from "../build/substitute.ts";

describe("substitute", () => {
  it("substitutes {{wake}} and {{helper}} from the per-harness map", () => {
    const source =
      "Wake via {{wake}}. Call the helper at {{helper}} to spawn.";
    const out = substitute(source, {
      wake: "your extension wakes you automatically",
      helper: "/usr/local/bin/herdr-helper",
    });

    expect(out).toBe(
      "Wake via your extension wakes you automatically. Call the helper at /usr/local/bin/herdr-helper to spawn.",
    );
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
    const source = "This misspells it: {{wak}}";
    expect(() => substitute(source, { wake: "x" })).toThrow(UnknownTokenError);
    try {
      substitute(source, { wake: "x" });
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownTokenError);
      expect((err as UnknownTokenError).token).toBe("{{wak}}");
    }
  });

  it("errors on a placeholder that looks like a token but is not one of the two", () => {
    expect(() => substitute("{{version}}", {})).toThrow(UnknownTokenError);
  });

  it("errors when a known token appears in source but the map omits its value", () => {
    expect(() => substitute("arm {{wake}} now", {})).toThrow(
      MissingTokenValueError,
    );
    expect(() => substitute("call {{helper}} now", { wake: "x" })).toThrow(
      MissingTokenValueError,
    );
  });

  it("substitutes when a token repeats within the source", () => {
    const out = substitute("{{helper}} and {{helper}}", {
      helper: "/bin/h",
    });
    expect(out).toBe("/bin/h and /bin/h");
  });
});
