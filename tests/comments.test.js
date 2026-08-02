import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchLine } from "../rules.js";

describe("commented-out lines", () => {
  it("does not flag commented-out eval()", () => {
    assert.equal(matchLine("app.js", 1, "// eval(userInput)").length, 0);
    assert.equal(matchLine("app.js", 1, "  // eval(userInput)").length, 0);
  });

  it("does not flag commented-out secrets", () => {
    assert.equal(
      matchLine(
        "app.js",
        1,
        "// const api_key = \"abcdefghijklmnopqrstuv\"",
      ).length,
      0,
    );
    assert.equal(
      matchLine("config.py", 1, "# password = \"hunter2hunter2\"").length,
      0,
    );
  });

  it("does not flag block-commented dangerous APIs", () => {
    assert.equal(
      matchLine("app.js", 1, "/* obj.__proto__ = evil */").length,
      0,
    );
  });

  it("does not flag HTML/SQL style comment lines", () => {
    assert.equal(
      matchLine("page.html", 1, "<!-- <div innerHTML=x> -->").length,
      0,
    );
    assert.equal(
      matchLine("q.sql", 1, "-- SELECT * FROM users WHERE id = '\" + id").length,
      0,
    );
  });

  it("still flags live (non-comment) dangerous code", () => {
    assert.ok(
      matchLine("app.js", 1, "eval(userInput)").some(
        (h) => h.ruleId === "code.eval",
      ),
    );
  });

  it("still allows mild.security-todo to match comment TODOs", () => {
    assert.ok(
      matchLine(
        "app.js",
        1,
        "// TODO: fix this XSS security hole",
      ).some((h) => h.ruleId === "mild.security-todo"),
    );
  });
});
