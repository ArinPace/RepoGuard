import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectStack } from "../src/detect.js";

describe("detectStack", () => {
  /** @type {string[]} */
  const dirs = [];

  function scratch() {
    const dir = mkdtempSync(join(tmpdir(), "rg-detect-"));
    dirs.push(dir);
    return dir;
  }

  it("detects node with build script and npm lock", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { build: "tsc -b" } }),
    );
    writeFileSync(join(dir, "package-lock.json"), "{}");
    const plan = detectStack(dir);
    assert.equal(plan?.stack, "node");
    assert.match(plan?.command || "", /npm ci/);
    assert.match(plan?.command || "", /npm run build/);
  });

  it("detects node install-only when no build script", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const plan = detectStack(dir);
    assert.equal(plan?.stack, "node");
    assert.match(plan?.detail || "", /install only/i);
  });

  it("detects go, rust, python, make", () => {
    const goDir = scratch();
    writeFileSync(join(goDir, "go.mod"), "module example.com/x\n");
    assert.equal(detectStack(goDir)?.stack, "go");

    const rustDir = scratch();
    writeFileSync(join(rustDir, "Cargo.toml"), "[package]\nname='x'\n");
    assert.equal(detectStack(rustDir)?.stack, "rust");

    const pyDir = scratch();
    writeFileSync(join(pyDir, "requirements.txt"), "requests==2.0.0\n");
    assert.equal(detectStack(pyDir)?.stack, "python");

    const makeDir = scratch();
    writeFileSync(join(makeDir, "Makefile"), "build:\n\t@echo ok\n");
    assert.equal(detectStack(makeDir)?.stack, "make");
  });

  it("returns null for empty dirs", () => {
    const dir = scratch();
    mkdirSync(join(dir, "src"));
    assert.equal(detectStack(dir), null);
  });

  // Cleanup after suite — node:test doesn't have after easily in all versions
  process.on("exit", () => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
