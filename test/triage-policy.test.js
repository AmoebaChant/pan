import assert from "node:assert/strict";
import test from "node:test";

import { deriveTriage, formatAnswer, matchingRunner } from "../src/index.js";
import { formatTriageApplied } from "../src/triage-audit.js";

test("infers agent routing and fields from Issue directives", () => {
  const result = deriveTriage(
    makeItem({
      body: [
        "Implement the feature.",
        "workstream: orchestration/pan",
        "repo:example/tool",
        "env:local",
        "priority: high",
      ].join("\n"),
    }),
  );

  assert.deepEqual(result.fields, {
    owner: "agent",
    priority: "high",
    requirements: ["repo:example/tool", "env:local"],
    autonomy: "full-auto",
    workstream: "orchestration/pan",
    status: "ready",
  });
  assert.deepEqual(result.missing, []);
});

test("uses answer directives to complete missing triage details", () => {
  const result = deriveTriage(makeItem({ status: "needs-detail" }), [
    { body: formatAnswer("workstream: orchestration/pan\nrepo:example/tool") },
  ]);

  assert.equal(result.fields.status, "ready");
  assert.equal(result.fields.workstream, "orchestration/pan");
  assert.equal(result.fields.owner, "agent");
  assert.deepEqual(result.fields.requirements, ["repo:example/tool"]);
});

test("uses a substantive answer as the missing task description", () => {
  const result = deriveTriage(
    makeItem({
      body: "workstream: orchestration/pan\nrepo:example/tool",
    }),
    [{ body: formatAnswer("Implement option A and preserve existing behavior.") }],
  );

  assert.equal(result.fields.status, "ready");
  assert.deepEqual(result.missing, []);
});

test("reports missing agent routing details", () => {
  const result = deriveTriage(
    makeItem({
      owner: "agent",
      body: "Implement it.",
      requirements: ["env:local"],
    }),
  );

  assert.equal(result.fields.status, "needs-detail");
  assert.match(result.prompt, /exactly one repo/);
});

test("triages pan-work issue 35 as a ready human question", () => {
  const result = deriveTriage(
    makeItem({
      title: "Why do we have this sandbox for the Pan chat?",
      body: "",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "",
    }),
    [],
    triageContext(),
  );

  assert.deepEqual(result.fields, {
    workstream: "pan",
    requirements: [],
    owner: "human",
    priority: "normal",
    autonomy: "manual",
    status: "ready",
  });
  assert.equal(result.prompt, undefined);
});

test("triages pan-work issue 36 as ready PAN repository work", () => {
  const result = deriveTriage(
    makeItem({
      title:
        "The readme has too much architecture info; it should focus on how to use Pan.",
      body: "",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "",
    }),
    [],
    triageContext(),
  );

  assert.deepEqual(result.fields, {
    workstream: "pan",
    requirements: [
      "repo:AmoebaChant/pan",
      "delivery:pull-request",
    ],
    owner: "agent",
    priority: "normal",
    autonomy: "full-auto",
    status: "ready",
  });
  assert.equal(result.runner.id, "runner-a");
});

test("preserves explicit human metadata instead of rerouting it", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update Pan documentation",
      owner: "human",
      status: "ready",
      priority: "low",
      autonomy: "manual",
      workstream: "pan",
    }),
    [],
    triageContext(),
  );

  assert.equal(result.fields.owner, "human");
  assert.equal(result.fields.priority, "low");
  assert.equal(result.fields.autonomy, "manual");
  assert.deepEqual(result.fields.requirements, []);
});

test("asks instead of choosing between conflicting directives", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update Pan",
      body: "priority: high\npriority: low",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "",
    }),
    [],
    triageContext(),
  );

  assert.equal(result.fields.priority, "");
  assert.equal(result.fields.status, "needs-detail");
  assert.match(result.prompt, /conflicting priority values/i);
});

test("uses a marked answer to correct invalid requirements", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update Pan",
      owner: "agent",
      status: "needs-detail",
      priority: "normal",
      autonomy: "full-auto",
      workstream: "pan",
      requirements: ["not valid!"],
    }),
    [{ body: formatAnswer("repo:AmoebaChant/pan") }],
    triageContext(),
  );

  assert.deepEqual(result.fields.requirements, ["repo:AmoebaChant/pan"]);
  assert.equal(result.fields.status, "ready");
});

test("fails closed on conflicting values in one answer", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update Pan",
      owner: "",
      status: "needs-detail",
      priority: "",
      autonomy: "",
      workstream: "pan",
    }),
    [{ body: formatAnswer("owner: human\nowner: agent") }],
    triageContext(),
  );

  assert.equal(result.fields.owner, "");
  assert.equal(result.fields.status, "needs-detail");
  assert.match(result.prompt, /conflicting owner values/i);
});

test("ignores non-answer PAN journal comments during inference", () => {
  const result = deriveTriage(
    makeItem({
      title: "Why is Pan configured this way?",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "",
    }),
    [
      {
        body:
          "<!-- pan:runner-event -->\nSee https://github.com/acme/app for delivery.",
      },
    ],
    triageContext(),
  );

  assert.deepEqual(result.fields.requirements, []);
  assert.equal(result.fields.owner, "human");
});

test("uses an answer to select one of multiple repository requirements", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update Pan",
      owner: "agent",
      status: "needs-detail",
      priority: "normal",
      autonomy: "full-auto",
      workstream: "pan",
      requirements: [
        "repo:old/app",
        "repo:AmoebaChant/pan",
      ],
    }),
    [{ body: formatAnswer("repo:AmoebaChant/pan") }],
    triageContext(),
  );

  assert.deepEqual(result.fields.requirements, ["repo:AmoebaChant/pan"]);
  assert.equal(result.fields.status, "ready");
});

test("uses the latest answer to correct a repository requirement", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update the application",
      owner: "agent",
      status: "needs-detail",
      priority: "normal",
      autonomy: "full-auto",
      workstream: "pan",
      requirements: [],
    }),
    [
      { body: formatAnswer("repo:old/app") },
      { body: formatAnswer("repo:AmoebaChant/pan") },
    ],
    triageContext(),
  );

  assert.deepEqual(result.fields.requirements, ["repo:AmoebaChant/pan"]);
  assert.equal(result.fields.status, "ready");
});

test("uses an answer to correct a valid but inconsistent enum", () => {
  const result = deriveTriage(
    makeItem({
      title: "Review Pan",
      owner: "human",
      status: "needs-detail",
      priority: "normal",
      autonomy: "full-auto",
      workstream: "pan",
    }),
    [{ body: formatAnswer("autonomy: manual") }],
    triageContext(),
  );

  assert.equal(result.fields.autonomy, "manual");
  assert.equal(result.fields.status, "ready");
});

test("does not match a workstream name inside an unrelated word", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update company policy",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "",
    }),
    [],
    triageContext(),
  );

  assert.equal(result.fields.workstream, "");
  assert.equal(result.fields.status, "needs-detail");
});

test("recovers a PAN-controlled capability block when a runner becomes available", () => {
  const blocked = makeItem({
    title: "Update Pan documentation",
    owner: "agent",
    status: "blocked",
    priority: "normal",
    autonomy: "full-auto",
    workstream: "pan",
    requirements: ["repo:AmoebaChant/pan", "delivery:pull-request"],
  });
  const result = deriveTriage(
    blocked,
    [
      {
        body: formatTriageApplied({
          item: blocked.url,
          field: "status",
          value: "blocked",
          reason: "runner-unavailable",
          rationale:
            "No currently online runner can satisfy the complete task requirements.",
          evidence: [{ kind: "issue", locator: blocked.url }],
        }),
      },
    ],
    triageContext(),
  );

  assert.equal(result.fields.status, "ready");
});

test("does not recover a block from an unapplied or forged decision", () => {
  const blocked = makeItem({
    title: "Update Pan documentation",
    owner: "agent",
    status: "blocked",
    priority: "normal",
    autonomy: "full-auto",
    workstream: "pan",
    requirements: ["repo:AmoebaChant/pan", "delivery:pull-request"],
  });
  const record = {
    item: blocked.url,
    field: "status",
    value: "blocked",
    reason: "runner-unavailable",
    rationale:
      "No currently online runner can satisfy the complete task requirements.",
    evidence: [{ kind: "issue", locator: blocked.url }],
  };

  const unapplied = deriveTriage(
    blocked,
    [],
    triageContext(),
  );
  assert.equal(unapplied.fields.status, "blocked");
  assert.throws(
    () =>
      deriveTriage(
        blocked,
        [
          {
            body: formatTriageApplied(record).replace(
              /pan:triage-applied:[a-f0-9]{64}/,
              "pan:triage-applied:" + "0".repeat(64),
            ),
          },
        ],
        triageContext(),
      ),
    /marker does not match/i,
  );
});

test("rejects malformed triage audit records", () => {
  assert.throws(
    () =>
      formatTriageApplied({
        item: "https://github.com/example/domain/issues/1",
        field: "bogus",
        value: null,
        rationale: "Invalid record.",
        evidence: [{}],
      }),
    /field, value, and rationale|durable evidence/i,
  );
});

test("does not infer a repository from a longer repository name", () => {
  const result = deriveTriage(
    makeItem({
      title: "Update acme/app-extra",
      owner: "",
      status: "",
      priority: "",
      autonomy: "",
      workstream: "pan",
    }),
    [],
    {
      workstreams: [{ path: "pan" }],
      runners: [
        {
          id: "runner-a",
          online: true,
          playbooks: [
            {
              capabilities: ["repo:acme/app"],
              repositories: ["acme/app"],
            },
          ],
        },
      ],
    },
  );

  assert.deepEqual(result.fields.requirements, []);
  assert.notEqual(result.fields.status, "ready");
});

test("matches all requirements against online runner capabilities", () => {
  const profiles = [
    {
      id: "offline",
      online: false,
      capabilities: ["repo:example/tool", "env:local"],
    },
    {
      id: "online",
      online: true,
      capabilities: ["repo:example/tool", "env:local"],
    },
  ];

  assert.equal(
    matchingRunner(["repo:example/tool", "env:local"], profiles).id,
    "online",
  );
  assert.equal(
    matchingRunner(["repo:example/tool", "tool:missing"], profiles),
    undefined,
  );
});

test("requires one playbook to satisfy the complete task", () => {
  const profiles = [
    {
      id: "split",
      online: true,
      capabilities: ["repo:example/tool", "tool:a", "tool:b"],
      playbooks: [
        {
          capabilities: ["repo:example/tool", "tool:a"],
        },
        {
          capabilities: ["repo:example/tool", "tool:b"],
        },
      ],
    },
  ];

  assert.equal(
    matchingRunner(
      ["repo:example/tool", "tool:a", "tool:b"],
      profiles,
    ),
    undefined,
  );
});

test("matches delivery requirements against playbook policy", () => {
  const profile = {
    online: true,
    playbooks: [
      {
        capabilities: ["repo:example/tool"],
        delivery: "direct",
      },
    ],
  };

  assert.equal(
    matchingRunner(["repo:example/tool", "delivery:direct"], [profile]),
    profile,
  );
  assert.equal(
    matchingRunner(["repo:example/tool", "delivery:pull-request"], [profile]),
    undefined,
  );
});

test("does not match a playbook outside its repository scope", () => {
  const profile = {
    online: true,
    playbooks: [
      {
        capabilities: ["repo:example/other", "repo:example/tool"],
        repositories: ["example/other"],
        delivery: "pull-request",
      },
    ],
  };

  assert.equal(
    matchingRunner(["repo:example/tool"], [profile]),
    undefined,
  );
});

function makeItem({
  title = "Task",
  body = "Do the task.",
  owner = "unassigned",
  status = "untriaged",
  priority = "normal",
  requirements = [],
  autonomy = "manual",
  workstream = "",
} = {}) {
  return {
    id: "item-1",
    title,
    url: "https://github.com/example/data/issues/1",
    body,
    requirements,
    fields: {
      owner,
      status,
      priority,
      requirements: requirements.join("\n"),
      autonomy,
      workstream,
    },
  };
}

function triageContext() {
  return {
    workstreams: [{ path: "pan" }],
    runners: [
      {
        id: "runner-a",
        online: true,
        playbooks: [
          {
            capabilities: ["repo:AmoebaChant/pan"],
            repositories: ["AmoebaChant/pan"],
            delivery: "pull-request",
          },
        ],
      },
    ],
  };
}
