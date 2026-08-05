import { describe, expect, it } from "vitest";
import { childEnv } from "../src/helper/spawn.js";

// The dev-loop env-forwarding contract: the gate plus every
// HERDR_SUBAGENT_* var the parent carries is always forwarded to children —
// no dev/prod switch. herdr's own HERDR_* vars are NOT forwarded (different
// owner), and the bare gate HERDR_SUBAGENT is always set.

describe("childEnv — dev-loop env forwarding", () => {
  it("sets the gate and forwards HERDR_SUBAGENT_* vars, nothing else", () => {
    const env = childEnv({
      HERDR_SUBAGENT: "1",
      HERDR_SUBAGENT_HELPER: "/repo/build/out/pi/herdr-helper",
      HERDR_SUBAGENT_DEBUG: "1",
      PATH: "/usr/bin",
      HOME: "/home/user",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    });

    expect(env).toEqual({
      HERDR_SUBAGENT: "1",
      HERDR_SUBAGENT_HELPER: "/repo/build/out/pi/herdr-helper",
      HERDR_SUBAGENT_DEBUG: "1",
    });
  });

  it("always sets the gate even when the parent did not carry it", () => {
    const env = childEnv({ PATH: "/usr/bin" });
    expect(env).toEqual({ HERDR_SUBAGENT: "1" });
  });

  it("ignores empty-valued HERDR_SUBAGENT_* vars", () => {
    const env = childEnv({
      HERDR_SUBAGENT_HELPER: "",
    });
    expect(env).toEqual({ HERDR_SUBAGENT: "1" });
  });
});
