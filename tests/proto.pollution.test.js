import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchLine } from "../rules.js";

function protoHits(filePath, lineText) {
  return matchLine(filePath, 1, lineText).filter(
    (hit) => hit.ruleId === "proto.pollution",
  );
}

describe("proto.pollution", () => {
  describe("positive — should flag", () => {
    it("flags obj.__proto__ = assignment", () => {
      assert.equal(
        protoHits("app.js", "obj.__proto__ = malicious").length,
        1,
      );
    });

    it("flags unquoted __proto__ object key", () => {
      assert.equal(
        protoHits("app.js", "Object.assign(target, { __proto__: dirty })")
          .length,
        1,
      );
    });

    it('flags obj["__proto__"] = assignment', () => {
      assert.equal(
        protoHits("app.js", 'obj["__proto__"] = malicious').length,
        1,
      );
    });

    it("flags obj['__proto__'] = assignment", () => {
      assert.equal(
        protoHits("app.js", "obj['__proto__'] = malicious").length,
        1,
      );
    });

    it("flags constructor.prototype property write", () => {
      assert.equal(
        protoHits("app.js", "obj.constructor.prototype.isAdmin = true")
          .length,
        1,
      );
    });

    it("flags constructor.prototype = assignment", () => {
      assert.equal(
        protoHits("app.js", "Fn.constructor.prototype = shared").length,
        1,
      );
    });

    it("flags constructor[key] = write pattern", () => {
      assert.equal(
        protoHits("app.js", "obj.constructor[prop] = value").length,
        1,
      );
    });
  });

  describe("negative — should not flag", () => {
    it("does not flag __proto__ inside rule why/prose strings", () => {
      assert.equal(
        protoHits(
          "rules.js",
          '    why: "Writing to __proto__ or constructor.prototype can change behavior for all objects and escalate to RCE in some apps.",',
        ).length,
        0,
      );
    });

    it("does not flag __proto__ inside rule fix strings", () => {
      assert.equal(
        protoHits(
          "rules.js",
          '    fix: "Block __proto__ and constructor keys when merging objects. Use Object.create(null) maps or hardened merge helpers.",',
        ).length,
        0,
      );
    });

    it("does not flag /__proto__/ regex in rule definitions", () => {
      assert.equal(
        protoHits("rules.js", "        /__proto__/.test(lineText) ||").length,
        0,
      );
    });

    it("does not flag constructor.prototype regex definitions", () => {
      assert.equal(
        protoHits(
          "rules.js",
          "        /\\bconstructor\\s*\\[|\\bconstructor\\.prototype\\b/.test(lineText)",
        ).length,
        0,
      );
    });

    it("does not flag title that only names the sink", () => {
      assert.equal(
        protoHits(
          "rules.js",
          '    title: "Prototype pollution sink (__proto__ / constructor.prototype)",',
        ).length,
        0,
      );
    });

    it("does not flag a lone __proto__ string without a write", () => {
      assert.equal(
        protoHits("app.js", 'const blocked = "__proto__";').length,
        0,
      );
    });

    it("does not flag reading __proto__ without assignment", () => {
      assert.equal(
        protoHits("app.js", "const proto = Object.getPrototypeOf(obj);")
          .length,
        0,
      );
    });

    it("does not flag comments mentioning __proto__", () => {
      assert.equal(
        protoHits("app.js", "// never assign to __proto__").length,
        0,
      );
    });
  });
});
