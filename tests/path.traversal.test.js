import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchLine } from "../rules.js";

function pathHits(filePath, lineText) {
  return matchLine(filePath, 1, lineText).filter(
    (hit) => hit.ruleId === "path.traversal",
  );
}

describe("path.traversal", () => {
  describe("positive — should flag", () => {
    it("flags readFile with ../ in the path string", () => {
      assert.equal(
        pathHits("app.js", "fs.readFile('../../etc/passwd', cb)").length,
        1,
      );
    });

    it("flags path.join with a ../ segment", () => {
      assert.equal(
        pathHits("app.js", "path.join(baseDir, '../secret')").length,
        1,
      );
    });

    it("flags sendFile with traversal", () => {
      assert.equal(
        pathHits("server.js", "res.sendFile('../../../etc/passwd')").length,
        1,
      );
    });

    it("flags createReadStream with ..\\ (Windows-style)", () => {
      assert.equal(
        pathHits("app.js", 'fs.createReadStream("..\\\\windows\\\\system32")')
          .length,
        1,
      );
    });

    it("flags open() with ../ path", () => {
      assert.equal(pathHits("io.py", 'open("../data/secret.txt")').length, 1);
    });

    it("flags PHP include with ../", () => {
      assert.equal(
        pathHits("index.php", 'include("../config/settings.php");').length,
        1,
      );
    });

    it("flags require with ../ path segment", () => {
      assert.equal(
        pathHits("app.js", "require('../../../evil/payload.js')").length,
        1,
      );
    });
  });

  describe("negative — should not flag", () => {
    it("does not flag ../ inside rule why/prose strings", () => {
      assert.equal(
        pathHits(
          "rules.js",
          '    why: "Using ../ in file paths (especially with user input) can let attackers read or write files outside the intended directory.",',
        ).length,
        0,
      );
    });

    it("does not flag path.traversal regex definitions", () => {
      assert.equal(
        pathHits(
          "rules.js",
          "      if (!/\\.\\.(\\/|\\\\)/.test(lineText)) return false;",
        ).length,
        0,
      );
    });

    it("does not flag hasPathTraversalToken helper using a regex", () => {
      assert.equal(
        pathHits(
          "rules.js",
          "  return /\\.\\.(\\/|\\\\)/.test(lineText);",
        ).length,
        0,
      );
    });

    it("does not flag title that only mentions (..)", () => {
      assert.equal(
        pathHits(
          "rules.js",
          '    title: "Possible path traversal (..)",',
        ).length,
        0,
      );
    });

    it("does not flag ../ alone without a path API call site", () => {
      assert.equal(
        pathHits("notes.js", 'const hint = "avoid ../ in uploads";').length,
        0,
      );
    });

    it("does not flag path APIs without a ../ token", () => {
      assert.equal(
        pathHits("app.js", 'fs.readFile("/var/data/ok.txt", cb)').length,
        0,
      );
    });

    it("does not flag comments mentioning ../ and path", () => {
      assert.equal(
        pathHits("app.js", "// check path for ../ sequences").length,
        0,
      );
    });
  });
});
