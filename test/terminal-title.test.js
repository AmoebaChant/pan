import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowTitleWriter,
  formatChatSessionName,
  formatRunnerWindowTitle,
  formatTaskSessionName,
  windowTitleSequence,
} from "../src/index.js";

test("formats a generic title when no task is assigned", () => {
  assert.equal(formatRunnerWindowTitle(), "Pan Runner");
  assert.equal(formatRunnerWindowTitle([]), "Pan Runner");
});

test("formats a single active task using its issue number", () => {
  assert.equal(formatRunnerWindowTitle([34]), "Pan Runner: Task 34");
  assert.equal(formatRunnerWindowTitle(["34"]), "Pan Runner: Task 34");
});

test("formats multiple active tasks in ascending, de-duplicated order", () => {
  assert.equal(
    formatRunnerWindowTitle([35, 34, 34]),
    "Pan Runner: Tasks 34, 35",
  );
});

test("ignores invalid task numbers", () => {
  assert.equal(
    formatRunnerWindowTitle([0, -1, "x", undefined, null, 34]),
    "Pan Runner: Task 34",
  );
});

test("wraps a title in an OSC set-title escape sequence", () => {
  assert.equal(
    windowTitleSequence("Pan Runner: Task 34"),
    "\u001b]0;Pan Runner: Task 34\u0007",
  );
});

test("writes the escape sequence only to a TTY stream", () => {
  const written = [];
  const tty = { isTTY: true, write: (value) => written.push(value) };
  createWindowTitleWriter(tty)("Pan Runner");
  assert.deepEqual(written, ["\u001b]0;Pan Runner\u0007"]);

  const piped = [];
  const nonTty = { isTTY: false, write: (value) => piped.push(value) };
  createWindowTitleWriter(nonTty)("Pan Runner");
  assert.deepEqual(piped, []);
});

test("formats a task session name from its issue", () => {
  assert.equal(
    formatTaskSessionName({
      issueNumber: 34,
      repository: "amoebachant/pan-life",
      title: "Fix the bird.txt typo",
    }),
    "Pan #34 pan-life: Fix the bird.txt typo",
  );
});

test("uses the whole repository when it has no owner segment", () => {
  assert.equal(
    formatTaskSessionName({
      issueNumber: 7,
      repository: "pan-life",
      title: "Hi",
    }),
    "Pan #7 pan-life: Hi",
  );
});

test("truncates an overlong task title with an ellipsis", () => {
  const title = "A".repeat(120);
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title,
  });
  assert.ok(name.startsWith("Pan #34 pan-life: "));
  assert.ok(name.endsWith("…"));
  const visibleTitle = name.slice(name.indexOf(": ") + 2);
  assert.ok(visibleTitle.length <= 60);
});

test("does not split an emoji at the truncation boundary", () => {
  const title = "A".repeat(59) + "😀" + "morecharsxxxxxx";
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title,
  });
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(name) && !/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name));
  assert.ok(name.endsWith("…"));
  assert.ok(name.startsWith("Pan #34 pan-life: "));
});

test("keeps a task title of exactly the maximum length intact", () => {
  const title = "A".repeat(60);
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title,
  });
  assert.equal(name, `Pan #34 pan-life: ${title}`);
  assert.ok(!name.endsWith("…"));
});

test("sanitizes escape and control characters out of a task name", () => {
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title: "before\u001b]0;evil\u0007after\nnext",
  });
  assert.ok(!name.includes("\u001b"));
  assert.ok(!name.includes("\u0007"));
  assert.ok(!name.includes("\n"));
  assert.ok(!name.includes("\r"));
  assert.ok(name.startsWith("Pan #34 pan-life: "));
});

test("strips C1 control characters that could inject OSC sequences", () => {
  const name = formatTaskSessionName({
    issueNumber: 1,
    repository: "a/b",
    title: "a\u009cb\u0085c",
  });
  assert.ok(!/[\u0080-\u009f]/.test(name));

  const chatName = formatChatSessionName({ repository: "own\u009cer/re\u0085po" });
  assert.ok(!/[\u0080-\u009f]/.test(chatName));
});

test("falls back to a task label when the title is empty", () => {
  assert.equal(
    formatTaskSessionName({
      issueNumber: 34,
      repository: "amoebachant/pan-life",
      title: "",
    }),
    "Pan #34 pan-life: Task 34",
  );
});

test("drops the issue number when it is missing or invalid", () => {
  assert.equal(
    formatTaskSessionName({
      repository: "amoebachant/pan-life",
      title: "Hi",
    }),
    "Pan pan-life: Hi",
  );
});

test("formats a chat session name from the full repository", () => {
  assert.equal(
    formatChatSessionName({ repository: "amoebachant/pan-life" }),
    "Pan Chat: amoebachant/pan-life",
  );
  assert.equal(
    formatChatSessionName({ repository: "pan-life" }),
    "Pan Chat: pan-life",
  );
  assert.equal(formatChatSessionName({}), "Pan Chat");
  assert.equal(formatChatSessionName(null), "Pan Chat");
});

test("never throws on a null argument", () => {
  assert.equal(formatTaskSessionName(null), "Pan: Task");
  assert.equal(formatChatSessionName(null), "Pan Chat");
});

test("strips Unicode bidi and directional control characters", () => {
  const name = formatTaskSessionName({
    issueNumber: 123,
    repository: "owner/repo",
    title: "normal \u202E43# naP",
  });
  assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name));
});

test("does not split a combining mark grapheme at the boundary", () => {
  // The first 59 clusters end with "é" (e + combining acute). truncate keeps
  // the first 59 clusters (MAX_TASK_TITLE_LENGTH - 1), so "é" is the last kept
  // cluster and must survive intact immediately before the ellipsis.
  const title = "A".repeat(58) + "e\u0301" + "Z".repeat(5);
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title,
  });
  assert.ok(name.endsWith("…"));
  assert.ok(name.includes("e\u0301…"));
});

test("does not split a ZWJ emoji sequence at the boundary", () => {
  const title = "A".repeat(58) + "👩‍💻" + "Z".repeat(5);
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "amoebachant/pan-life",
    title,
  });
  assert.ok(name.endsWith("…"));
  assert.ok(!/👩(?!\u200d💻)/u.test(name));
  assert.ok(!name.endsWith("\u200d"));
});

test("bounds an overlong repository segment", () => {
  const name = formatTaskSessionName({
    issueNumber: 34,
    repository: "owner/" + "a".repeat(200),
    title: "Hi",
  });
  const beforeColon = name.slice(0, name.indexOf(": "));
  const repoSegment = beforeColon.slice(beforeColon.indexOf("#34 ") + 4);
  assert.ok(Array.from(repoSegment).length <= 40);
});

test("bounds the final task session name length", () => {
  // A 15-digit issue number inflates the prefix to "Pan #999999999999999"
  // (20 chars). Combined with a repository at the 40-cap and a title at the
  // 60-cap, the pre-backstop composed string is 20 + 1 + 40 + 2 + 60 = 123,
  // so the 120 final backstop must truncate it (leaving a trailing ellipsis).
  const name = formatTaskSessionName({
    issueNumber: 999999999999999,
    repository: "owner/" + "a".repeat(200),
    title: "b".repeat(200),
  });
  assert.ok(Array.from(name).length <= 120);
  assert.ok(name.endsWith("…"));
});

test("bounds the final chat session name length", () => {
  // A chat name is at most "Pan Chat: " (10) + a 40-cap repository = 50 chars,
  // so it can never reach the 120 backstop; this only exercises the bound.
  const name = formatChatSessionName({
    repository: "owner/" + "c".repeat(300),
  });
  assert.ok(Array.from(name).length <= 120);
});

test("strips bidi control characters from the repository segment", () => {
  const name = formatTaskSessionName({
    issueNumber: 123,
    repository: "owner/re\u202Epo",
    title: "Hi",
  });
  assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name));
});

test("bounds an overlong chat repository segment", () => {
  const name = formatChatSessionName({ repository: "o".repeat(200) });
  const repoPortion = name.slice("Pan Chat: ".length);
  assert.ok(Array.from(repoPortion).length <= 40);
});

test("caps code points even when combining marks collapse into one grapheme", () => {
  const bomb = formatTaskSessionName({ issueNumber: 1, repository: "o/r", title: "a" + "\u0301".repeat(50000) });
  assert.ok(Array.from(bomb).length <= 256);

  const chatBomb = formatChatSessionName({ repository: "o/" + "\u0301".repeat(50000) });
  assert.ok(Array.from(chatBomb).length <= 256);
});
