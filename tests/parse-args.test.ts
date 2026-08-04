import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/helper/cli";

// parseArgs must accept values that start with `--` for value-bearing flags.
// Without that, `helper spawn --label "--refactor" ...` drops the label value
// and reads the flag as `true`. Bare flags still default to `true`.

describe("parseArgs value-bearing flags", () => {
  it("preserves a --label value that starts with --", () => {
    const flags = parseArgs([
      "spawn",
      "--kind", "pi",
      "--agent", "doer",
      "--label", "--refactor",
      "--body", "<supervisor-agent>x</supervisor-agent>",
    ]);
    expect(flags.label).toBe("--refactor");
    expect(flags.kind).toBe("pi");
    expect(flags.agent).toBe("doer");
    expect(flags.body).toBe("<supervisor-agent>x</supervisor-agent>");
  });

  it("preserves a --body value that itself starts with --", () => {
    const flags = parseArgs([
      "spawn",
      "--kind", "claude",
      "--agent", "doer",
      "--label", "x",
      "--body", "--weird-prefix content",
    ]);
    expect(flags.body).toBe("--weird-prefix content");
  });

  it("preserves a --agent value that starts with --", () => {
    const flags = parseArgs(["--agent", "--name", "--label", "x"]);
    expect(flags.agent).toBe("--name");
  });

  it("preserves --timeout value that starts with -- (e.g. a negative-ish token)", () => {
    const flags = parseArgs(["w1Z:p1", "--timeout", "--5000"]);
    expect(flags.timeout).toBe("--5000");
  });

  it("treats every value-bearing flag the same: consumes next token regardless of leading --", () => {
    for (const key of ["kind", "agent", "label", "body", "cwd", "workspace", "timeout"]) {
      const flags = parseArgs([`--${key}`, "--value"]);
      expect(flags[key]).toBe("--value");
    }
  });
});

describe("parseArgs bare and unknown flags", () => {
  it("defaults a bare value-bearing flag (no following token) to true", () => {
    const flags = parseArgs(["--label"]);
    expect(flags.label).toBe("true");
  });

  it("defaults a bare boolean flag to true", () => {
    const flags = parseArgs(["--focus"]);
    expect(flags.focus).toBe("true");
  });

  it("consumes a non--- value for an unknown flag", () => {
    const flags = parseArgs(["--unknown", "value"]);
    expect(flags.unknown).toBe("value");
  });

  it("treats a bare -- separator as a no-op (does not eat the next token)", () => {
    // A standalone `--` is the conventional separator: it is not a flag and
    // must not consume the following token. Here --focus reads as true and
    // --label still gets its value.
    const flags = parseArgs(["--focus", "--", "--label", "x"]);
    expect(flags.focus).toBe("true");
    expect(flags.label).toBe("x");
    expect(flags[""]).toBeUndefined();
  });

  it("ignores positional (non-flag) tokens", () => {
    const flags = parseArgs(["w1Z:p1", "--label", "x", "extra"]);
    expect(flags.label).toBe("x");
    expect(flags["w1Z:p1"]).toBeUndefined();
  });
});
