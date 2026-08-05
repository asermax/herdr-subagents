import { describe, expect, it } from "vitest";
import { passthroughArgs } from "../src/helper/cli";

// passthroughArgs scans the spawn subcommand's rawArgs (already post-
// subcommand) and forwards every `--flag value` pair spawn does not consume
// itself. citty cannot round-trip unknown flag pairs, so passthrough is built
// from rawArgs, never from parsed args.

describe("passthroughArgs forwards unknown flags", () => {
  it("forwards an unknown --flag value pair verbatim", () => {
    const out = passthroughArgs(["--extension", "/repo/src/extension/index.ts"]);
    expect(out).toEqual(["--extension", "/repo/src/extension/index.ts"]);
  });

  it("forwards multiple unknown pairs in order", () => {
    const out = passthroughArgs([
      "--extension", "/repo/ext",
      "--skill", "/repo/skills",
    ]);
    expect(out).toEqual(["--extension", "/repo/ext", "--skill", "/repo/skills"]);
  });

  it("forwards a bare unknown flag (no value) as-is", () => {
    const out = passthroughArgs(["--verbose"]);
    expect(out).toEqual(["--verbose"]);
  });
});

describe("passthroughArgs forwards spawn --body to the child", () => {
  it("forwards --body since spawn no longer owns it", () => {
    // spawn dropped --body (the delegate skill's spawn/prompt split): a stray
    // --body now rides passthrough to the child's harness.
    const out = passthroughArgs(["--kind", "pi", "--label", "x", "--body", "x"]);
    expect(out).toEqual(["--body", "x"]);
  });
});

describe("passthroughArgs skips spawn's own flags", () => {
  it("drops each own flag and its value", () => {
    const out = passthroughArgs([
      "--kind", "pi",
      "--agent", "doer",
      "--label", "do it",
      "--cwd", "/repo",
      "--workspace", "w1Z",
    ]);
    expect(out).toEqual([]);
  });

  it("drops own flags but keeps the surrounding forwarded flags", () => {
    const out = passthroughArgs([
      "--kind", "pi",
      "--agent", "doer",
      "--label", "do it",
      "--extension", "/repo/ext",
      "--skill", "/repo/skills",
    ]);
    expect(out).toEqual(["--extension", "/repo/ext", "--skill", "/repo/skills"]);
  });

  it("drops a bare own flag (no following value)", () => {
    const out = passthroughArgs(["--kind", "--extension", "x"]);
    // --kind is own and its next token --extension starts with --, so the
    // value is not consumed; --extension then forwards with its own value.
    expect(out).toEqual(["--extension", "x"]);
  });
});

describe("passthroughArgs separators and value shapes", () => {
  it("skips a bare -- separator without consuming the next token", () => {
    const out = passthroughArgs(["--", "--extension", "x"]);
    expect(out).toEqual(["--extension", "x"]);
  });

  it("ignores positional (non-flag) tokens", () => {
    const out = passthroughArgs(["w1Z:p1", "--extension", "x", "extra"]);
    expect(out).toEqual(["--extension", "x"]);
  });

  it("keeps a -- value attached to an unknown flag (two bare flags)", () => {
    // An unknown flag whose next token starts with -- is not consumed as a
    // value; both forward as separate flags, matching the prior parser.
    const out = passthroughArgs(["--weird", "--value"]);
    expect(out).toEqual(["--weird", "--value"]);
  });
});
