import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchLine } from "../rules.js";

function nosqlHits(filePath, lineText) {
  return matchLine(filePath, 1, lineText).filter(
    (hit) => hit.ruleId === "nosql.injection",
  );
}

describe("nosql.injection", () => {
  describe("positive — should flag", () => {
    it("flags bare $where object key in find()", () => {
      assert.equal(
        nosqlHits(
          "db.js",
          'db.users.find({ $where: "this.credits == this.debits" })',
        ).length,
        1,
      );
    });

    it('flags quoted "$where" object key', () => {
      assert.equal(
        nosqlHits("db.js", 'collection.find({ "$where": userExpr })').length,
        1,
      );
    });

    it("flags '$where' object key with single quotes", () => {
      assert.equal(
        nosqlHits("db.js", "collection.find({ '$where': code })").length,
        1,
      );
    });

    it("flags bracket assignment of $where", () => {
      assert.equal(
        nosqlHits("db.js", 'query["$where"] = req.body.filter').length,
        1,
      );
    });

    it("flags Model.find(req.body)", () => {
      assert.equal(nosqlHits("api.js", "User.find(req.body)").length, 1);
    });

    it("flags findOne with request.json", () => {
      assert.equal(
        nosqlHits("api.py", "collection.findOne(request.json)").length,
        1,
      );
    });

    it("flags updateOne with req.query", () => {
      assert.equal(
        nosqlHits("routes.js", "docs.updateOne(req.query)").length,
        1,
      );
    });

    it("flags deleteOne with params", () => {
      assert.equal(
        nosqlHits("routes.js", "await Item.deleteOne(params)").length,
        1,
      );
    });
  });

  describe("negative — should not flag", () => {
    it("does not flag $where inside a regex literal (rule definitions)", () => {
      assert.equal(
        nosqlHits("rules.js", "        /\\$where\\b/.test(lineText) ||").length,
        0,
      );
    });

    it("does not flag $where inside a find-pattern regex literal", () => {
      assert.equal(
        nosqlHits(
          "rules.js",
          "        /\\bfind\\s*\\(\\s*\\{[^}]*\\$where/.test(lineText) ||",
        ).length,
        0,
      );
    });

    it("does not flag $where mentioned in rule title/why prose strings", () => {
      assert.equal(
        nosqlHits(
          "rules.js",
          '    title: "Possible NoSQL injection ($where / operator injection)",',
        ).length,
        0,
      );
      assert.equal(
        nosqlHits(
          "rules.js",
          '    why: "Passing user JSON can inject operators ($gt, $where) and bypass filters.",',
        ).length,
        0,
      );
    });

    it("does not flag id strings that only name the rule", () => {
      assert.equal(
        nosqlHits("rules.js", '    id: "nosql.injection",').length,
        0,
      );
    });

    it("does not flag ordinary find without user input or $where", () => {
      assert.equal(
        nosqlHits("db.js", 'User.find({ email: "a@b.com" })').length,
        0,
      );
    });

    it("does not flag client fetch mentions of $where in comments", () => {
      assert.equal(
        nosqlHits("app.js", "// avoid $where in queries").length,
        0,
      );
    });

    it("does not flag req.body used without a Mongo method", () => {
      assert.equal(
        nosqlHits("api.js", "const payload = req.body;").length,
        0,
      );
    });
  });
});
