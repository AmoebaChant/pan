import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDomainIssues,
  parseWorkstreamIssueUrl,
  WorkstreamIssueStore,
} from "../src/index.js";

test("validates Workstream Issue URLs against the configured repository and label", async () => {
  const store = new WorkstreamIssueStore({
    repository: "example/domain",
    gh: {
      async runJson() {
        return {
          number: 7,
          title: "Runtime",
          body: "# Runtime",
          url: "https://github.com/example/domain/issues/7",
          state: "OPEN",
          labels: [{ name: "Workstream" }],
          comments: [],
          createdAt: "2026-07-01T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
        };
      },
    },
  });

  const workstream = await store.validate(
    "https://github.com/example/domain/issues/7",
  );

  assert.equal(workstream.title, "Runtime");
  assert.equal(
    parseWorkstreamIssueUrl(workstream.url, "example/domain").number,
    7,
  );
  assert.throws(
    () =>
      parseWorkstreamIssueUrl(
        "https://github.com/other/domain/issues/7",
        "example/domain",
      ),
    /configured domain|reference an Issue in/,
  );
});

test("classifies Workstreams, tasks, and both invalid states", () => {
  const issues = [
    issue(1, ["Workstream"]),
    issue(2, []),
    issue(3, ["Workstream"]),
    issue(4, []),
  ];
  const projectItems = [
    item(2),
    item(3),
  ];

  const classified = classifyDomainIssues(issues, projectItems);

  assert.deepEqual(
    classified.map(({ issue, type, valid, code, proposal }) => ({
      number: issue.number,
      type,
      valid,
      code,
      proposal,
    })),
    [
      {
        number: 1,
        type: "workstream",
        valid: true,
        code: undefined,
        proposal: undefined,
      },
      {
        number: 2,
        type: "task",
        valid: true,
        code: undefined,
        proposal: undefined,
      },
      {
        number: 3,
        type: "workstream",
        valid: false,
        code: "workstream-in-backlog",
        proposal: "remove-from-project",
      },
      {
        number: 4,
        type: "unclassified",
        valid: false,
        code: "issue-outside-backlog",
        proposal: "add-as-task",
      },
    ],
  );
});

test("reads parent and child Workstream relationships", async () => {
  const store = new WorkstreamIssueStore({
    repository: "example/domain",
    gh: {
      async runJson(args) {
        const endpoint = args.find((arg) => arg.startsWith("repos/"));
        if (endpoint?.endsWith("/sub_issues?per_page=100")) {
          return [
            {
              number: 8,
              title: "Child",
              html_url: "https://github.com/example/domain/issues/8",
              state: "open",
            },
          ];
        }
        if (endpoint?.endsWith("/parent")) {
          return {
            number: 6,
            title: "Parent",
            html_url: "https://github.com/example/domain/issues/6",
            state: "open",
          };
        }
        throw new Error(`Unexpected call: ${args.join(" ")}`);
      },
    },
  });

  const hierarchy = await store.hierarchy(
    "https://github.com/example/domain/issues/7",
  );

  assert.equal(hierarchy.parent.number, 6);
  assert.equal(hierarchy.children[0].number, 8);
});

function issue(number, labels) {
  return {
    number,
    url: `https://github.com/example/domain/issues/${number}`,
    state: "OPEN",
    labels: labels.map((name) => ({ name })),
  };
}

function item(number) {
  return {
    number,
    url: `https://github.com/example/domain/issues/${number}`,
    contentClassification: "domain-issue",
  };
}
