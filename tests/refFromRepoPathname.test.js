import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { refFromRepoPathname } from "../github.js";

describe("refFromRepoPathname", () => {
  it("reads tree and blob refs", () => {
    assert.equal(
      refFromRepoPathname("/owner/repo/tree/main/src"),
      "main",
    );
    assert.equal(
      refFromRepoPathname("/owner/repo/blob/feature-x/file.js"),
      "feature-x",
    );
  });

  it("returns null without tree/blob", () => {
    assert.equal(refFromRepoPathname("/owner/repo"), null);
    assert.equal(refFromRepoPathname("/owner/repo/issues/1"), null);
  });
});
