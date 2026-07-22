#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.PAN_FAKE_GH_STATE;
const operation = process.env.PAN_FAKE_OPERATION;
const state = JSON.parse(readFileSync(statePath, "utf8"));

if (state.runId !== process.env.PAN_FAKE_RUN_ID) {
  state.runId = process.env.PAN_FAKE_RUN_ID;
  state.calls = 0;
}
const call = state.calls++;

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function fail(message) {
  save();
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function respond(value) {
  state.lastResponse = {
    call,
    contentType: typeof value.content,
  };
  save();
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sha(value) {
  return createHash("sha1").update(value).digest("hex");
}

function encodedLeader() {
  return {
    content: Buffer.from(state.leader.content).toString("base64"),
    sha: state.leader.sha,
  };
}

function nextLeader(expiresAt) {
  const content = JSON.stringify({
    version: 1,
    holder: process.env.PAN_LEADERSHIP_HOLDER,
    token: process.env.PAN_LEADERSHIP_GENERATION,
    sessionId: process.env.PAN_SESSION_ID,
    holderKind: "copilot-session",
    expiresAt,
  });
  state.leader = { content, sha: sha(content) };
}

if (operation === "evidence.issues") {
  if (state.failPagination) {
    fail("synthetic pagination failure");
  } else {
    respond([{
      number: 1,
      pull_request: {},
      html_url: "https://github.com/example/domain/pull/1",
      title: "Synthetic pull request",
      body: "",
      state: "open",
      created_at: "2026-07-22T00:00:00Z",
      updated_at: "2026-07-22T00:00:00Z",
      labels: [],
      assignees: [],
    }]);
  }
} else if (operation === "leadership.acquire") {
  if (call === 0) {
    respond({ object: { sha: "base-sha" } });
  } else if (call === 1 && state.leader) {
    respond(encodedLeader());
  } else if (call === 1) {
    fail("404 Not Found");
  } else if (call === 2 && !state.leader) {
    nextLeader("2099-01-01T00:00:00.000Z");
    respond({ content: { sha: state.leader.sha } });
  } else {
    respond(encodedLeader());
  }
} else if (operation === "leadership.assert") {
  respond(call === 0 ? { object: { sha: "base-sha" } } : encodedLeader());
} else if (operation === "leadership.release") {
  if (call === 0) {
    respond({ object: { sha: "base-sha" } });
  } else if (call === 1) {
    respond(encodedLeader());
  } else {
    state.leader = undefined;
    respond({ content: { sha: "released" } });
  }
} else {
  fail(`Unsupported fake gh operation: ${operation}`);
}
