import assert from "node:assert/strict";
import test from "node:test";

import {
  createWindowTitleWriter,
  formatRunnerWindowTitle,
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
