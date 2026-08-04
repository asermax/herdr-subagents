// packageRoot resolves the helper's package root by walking up to the nearest
// package.json — robust to compiled layouts where the extension file is not one
// level under the root (bug #8).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../src/extension/parent-role.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "herdr-pkgroot-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("packageRoot", () => {
  it("walks up to the nearest package.json from a nested compiled layout", () => {
    // <tmp>/pkg/package.json, extension shipped under <tmp>/pkg/dist/extension/
    const pkg = join(tmpDir, "pkg");
    const extDir = join(pkg, "dist", "extension");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"test"}');

    expect(packageRoot(extDir)).toBe(pkg);
  });

  it("resolves the simple layout (extension one level under the root)", () => {
    const pkg = join(tmpDir, "pkg");
    const extDir = join(pkg, "extension");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(pkg, "package.json"), '{"name":"test"}');

    expect(packageRoot(extDir)).toBe(pkg);
  });

  it("picks the nearest, not an outer, package.json", () => {
    const outer = join(tmpDir, "outer");
    const inner = join(outer, "inner");
    const extDir = join(inner, "extension");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(outer, "package.json"), '{"name":"outer"}');
    writeFileSync(join(inner, "package.json"), '{"name":"inner"}');

    expect(packageRoot(extDir)).toBe(inner);
  });
});
