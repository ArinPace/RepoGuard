import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { matchLine } from "../rules.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function hitsFor(ruleId, filePath, lineText) {
  return matchLine(filePath, 1, lineText).filter((h) => h.ruleId === ruleId);
}

describe("self-scan regression", () => {
  describe("test/fixture paths skip semantic rules", () => {
    it("does not treat vulnerable snippets in tests/*.test.js as production code", () => {
      assert.equal(
        hitsFor(
          "nosql.injection",
          "tests/nosql.injection.test.js",
          'db.users.find({ $where: "this.credits == this.debits" })',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "proto.pollution",
          "tests/proto.pollution.test.js",
          "obj.__proto__ = malicious",
        ).length,
        0,
      );
      assert.equal(
        hitsFor("code.eval", "tests/foo.test.js", "eval(userInput)").length,
        0,
      );
      assert.equal(
        hitsFor("code.eval", "__tests__/app.js", "eval(userInput)").length,
        0,
      );
      assert.equal(
        hitsFor("code.eval", "fixtures/sample.js", "eval(userInput)").length,
        0,
      );
    });

    it("still flags the same snippets when path is production-like", () => {
      assert.equal(
        hitsFor(
          "nosql.injection",
          "db.js",
          'db.users.find({ $where: "this.credits == this.debits" })',
        ).length,
        1,
      );
      assert.equal(
        hitsFor("proto.pollution", "app.js", "obj.__proto__ = malicious")
          .length,
        1,
      );
      assert.equal(
        hitsFor("code.eval", "app.js", "eval(userInput)").length,
        1,
      );
    });

    it("still runs secret rules on test paths", () => {
      assert.ok(
        hitsFor(
          "secret.api-key-assignment",
          "tests/secrets.test.js",
          'const api_key = "abcdefghijklmnopqrstuv"',
        ).length >= 1,
      );
    });
  });

  describe("sql.concat", () => {
    it("does not flag its own regex or prose in rules.js", () => {
      assert.equal(
        hitsFor(
          "sql.concat",
          "rules.js",
          "        /\\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\\b/i.test(withoutRegex);",
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "sql.concat",
          "rules.js",
          '    title: "SQL built with string concatenation or interpolation",',
        ).length,
        0,
      );
    });

    it("flags real SQL concatenation", () => {
      assert.equal(
        hitsFor(
          "sql.concat",
          "db.js",
          'const q = "SELECT * FROM users WHERE id=" + userId;',
        ).length,
        1,
      );
    });
  });

  describe("code.eval / code.function-constructor", () => {
    it("ignores titles, why text, and detection regexes", () => {
      assert.equal(
        hitsFor("code.eval", "rules.js", '    title: "Use of eval()",')
          .length,
        0,
      );
      assert.equal(
        hitsFor(
          "code.eval",
          "rules.js",
          "      return /(^|[^.\\w])eval\\s*\\(/.test(executableCode);",
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "code.function-constructor",
          "rules.js",
          '    title: "Use of new Function()",',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "code.function-constructor",
          "rules.js",
          "      return /\\bnew\\s+Function\\s*\\(/.test(executableCode);",
        ).length,
        0,
      );
    });

    it("flags real eval / new Function calls", () => {
      assert.equal(
        hitsFor("code.eval", "app.js", "eval(userInput)").length,
        1,
      );
      assert.equal(
        hitsFor(
          "code.function-constructor",
          "app.js",
          "const fn = new Function(source);",
        ).length,
        1,
      );
    });
  });

  describe("crypto rules", () => {
    it("createCipher ignores rule titles/regexes but flags real calls", () => {
      assert.equal(
        hitsFor(
          "crypto.nodejs-createcipher",
          "rules.js",
          '    title: "Deprecated crypto.createCipher (not createCipheriv)",',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "crypto.nodejs-createcipher",
          "crypto.js",
          "crypto.createCipher('aes192', password)",
        ).length,
        1,
      );
      assert.equal(
        hitsFor(
          "crypto.nodejs-createcipher",
          "crypto.js",
          "crypto.createCipheriv('aes-256-gcm', key, iv)",
        ).length,
        0,
      );
    });

    it("md5/sha1 requires hashing patterns, not prose", () => {
      assert.equal(
        hitsFor(
          "crypto.md5-or-sha1-password",
          "rules.js",
          '    title: "MD5/SHA1 used in a password-like context",',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "crypto.md5-or-sha1-password",
          "auth.js",
          "const digest = md5(password);",
        ).length,
        1,
      );
      assert.equal(
        hitsFor(
          "crypto.md5-or-sha1-password",
          "auth.js",
          'createHash("md5").update(password)',
        ).length,
        1,
      );
    });

    it("weak-cipher requires cipher APIs, not bare DES mentions", () => {
      assert.equal(
        hitsFor(
          "crypto.weak-cipher",
          "rules.js",
          '    title: "Weak or obsolete cipher (DES/RC4/ECB)",',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "crypto.weak-cipher",
          "crypto.js",
          'Cipher.getInstance("AES/ECB/PKCS5Padding")',
        ).length,
        1,
      );
    });
  });

  describe("xss.document-write / react dangerouslySetInnerHTML", () => {
    it("ignores rule definitions", () => {
      assert.equal(
        hitsFor(
          "xss.document-write",
          "rules.js",
          "      return /\\bdocument\\.write(ln)?\\s*\\(/.test(executableCode);",
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "xss.react-dangerously-set-html",
          "rules.js",
          '    title: "React dangerouslySetInnerHTML",',
        ).length,
        0,
      );
    });

    it("flags real sinks", () => {
      assert.equal(
        hitsFor(
          "xss.document-write",
          "app.js",
          "document.write(userHtml)",
        ).length,
        1,
      );
      assert.equal(
        hitsFor(
          "xss.react-dangerously-set-html",
          "App.jsx",
          "return <div dangerouslySetInnerHTML={{ __html: html }} />;",
        ).length,
        1,
      );
    });
  });

  describe("config.debug-enabled", () => {
    it("ignores its own regex", () => {
      assert.equal(
        hitsFor(
          "config.debug-enabled",
          "rules.js",
          "        /\\bdebug\\s*[:=]\\s*true\\b/i.test(withoutRegex) ||",
        ).length,
        0,
      );
    });

    it("flags real debug assignments", () => {
      assert.equal(
        hitsFor("config.debug-enabled", "config.js", "debug: true,").length,
        1,
      );
      assert.equal(
        hitsFor("config.debug-enabled", "app.env", "DEBUG=true").length,
        1,
      );
    });
  });

  describe("mild.security-todo", () => {
    it("only matches comment text, not titles", () => {
      assert.equal(
        hitsFor(
          "mild.security-todo",
          "rules.js",
          '    title: "Security-related TODO/FIXME",',
        ).length,
        0,
      );
      assert.equal(
        hitsFor(
          "mild.security-todo",
          "app.js",
          "// TODO: fix this XSS security hole",
        ).length,
        1,
      );
      assert.equal(
        hitsFor(
          "mild.security-todo",
          "app.js",
          'const url = "https://example.com/TODO/security";',
        ).length,
        0,
      );
    });
  });

  describe("UI HTML sinks removed", () => {
    it("sidepanel.js and content.js have no innerHTML/outerHTML assignments", () => {
      for (const rel of ["sidepanel.js", "content.js"]) {
        const text = readFileSync(join(root, rel), "utf8");
        const offenders = text
          .split(/\n/)
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => /\.(innerHTML|outerHTML)\s*=/.test(line));
        assert.deepEqual(
          offenders,
          [],
          `${rel} still assigns innerHTML/outerHTML: ${JSON.stringify(offenders)}`,
        );
      }
    });
  });
});
