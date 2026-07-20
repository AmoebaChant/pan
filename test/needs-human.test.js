import assert from "node:assert/strict";
import test from "node:test";

import {
  answerTexts,
  formatAnswer,
  formatNeedsHuman,
  latestNeedsHuman,
  pullRequestUrl,
} from "../src/index.js";

test("tracks unresolved needs-human records across answers and results", () => {
  const question = formatNeedsHuman({
    kind: "question",
    prompt: "Choose an option.",
    locator: { machine: "machine-a" },
  });
  const comments = [{ body: question }, { body: formatAnswer("Option A") }];

  assert.equal(latestNeedsHuman(comments), undefined);
  assert.deepEqual(answerTexts(comments), ["Option A"]);

  comments.push({ body: question, url: "comment-url" });
  assert.equal(latestNeedsHuman(comments).commentUrl, "comment-url");
});

test("finds the pull request in a runner result comment", () => {
  assert.equal(
    pullRequestUrl([
      {
        body: [
          "<!-- pan:runner-result -->",
          "### Runner completed",
          "",
          "Done.",
          "",
          "Pull request: https://github.com/example/tool/pull/42",
        ].join("\n"),
      },
    ]),
    "https://github.com/example/tool/pull/42",
  );
});

