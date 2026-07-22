import assert from "node:assert/strict";
import test from "node:test";

import {
  MISSING_ISSUE_INITIAL_FIELDS,
  ReconciliationService,
} from "../src/index.js";

const REPOSITORY = "example/domain";

test("plans only eligible open domain Issues from complete evidence", async () => {
  const store = new ReconciliationStore({
    issues: [
      issue(1),
      issue(2, { state: "closed" }),
      issue(3, { repository: "other/domain" }),
      { ...issue(4), id: undefined },
      issue(5, { pull_request: {} }),
    ],
    items: [projectItem(1)],
  });

  const plan = await new ReconciliationService({ store }).planMissingIssues();

  assert.equal(plan.complete, true);
  assert.deepEqual(plan.additions.map(({ issue: candidate }) => candidate.number), []);
  assert.equal(plan.exclusions.length, 4);
});

test("reports exact missing additions without side effects in dry-run mode", async () => {
  const store = new ReconciliationStore({ issues: [issue(1), issue(2)] });
  const service = new ReconciliationService({ store });

  const result = await service.reconcileMissingIssues();

  assert.equal(result.status, "confirmed");
  assert.deepEqual(
    result.confirmedEffects,
    [
      "Planned Project registration for Issue #1.",
      "Planned Project registration for Issue #2.",
    ],
  );
  assert.equal(store.membershipCalls, 0);
});

test("adds each missing Issue once and confirms deterministic initial fields", async () => {
  const store = new ReconciliationStore({ issues: [issue(1)] });
  const service = new ReconciliationService({ store });

  const first = await service.reconcileMissingIssues({ apply: true });
  const second = await service.reconcileMissingIssues({ apply: true });

  assert.equal(first.status, "confirmed");
  assert.equal(second.status, "confirmed");
  assert.equal(store.membershipAdds, 1);
  assert.deepEqual(store.items[0].fields, MISSING_ISSUE_INITIAL_FIELDS);
});

test("preserves a registered item and repairs its fields on retry", async () => {
  const store = new ReconciliationStore({
    issues: [issue(1)],
    failFieldSetupOnce: true,
  });
  const service = new ReconciliationService({ store });

  const interrupted = await service.reconcileMissingIssues({ apply: true });
  const retried = await service.reconcileMissingIssues({ apply: true });

  assert.equal(interrupted.status, "incomplete");
  assert.match(interrupted.confirmedEffects[0], /Added existing Issue #1/);
  assert.equal(store.membershipAdds, 1);
  assert.equal(retried.status, "confirmed");
  assert.equal(store.membershipAdds, 1);
  assert.deepEqual(store.items[0].fields, MISSING_ISSUE_INITIAL_FIELDS);
});

test("stops after leadership loss between membership and field initialization", async () => {
  const store = new ReconciliationStore({ issues: [issue(1)] });
  let assertions = 0;
  const service = new ReconciliationService({
    store,
    assertLeadership: async () => ({
      asserted: ++assertions === 1,
      reason: "Leadership was lost.",
    }),
  });

  const result = await service.reconcileMissingIssues({ apply: true });

  assert.equal(result.status, "incomplete");
  assert.equal(store.membershipAdds, 1);
  assert.deepEqual(store.items[0].fields, {});
  assert.equal(result.remainingSteps.length, 1);
});

test("rejects an apply when the catalog revision changes after planning", async () => {
  const store = new ReconciliationStore({ issues: [issue(1)] });
  store.changeCatalogOnSecondRead = true;
  const service = new ReconciliationService({ store });

  const result = await service.reconcileMissingIssues({ apply: true });

  assert.equal(result.status, "incomplete");
  assert.equal(store.membershipAdds, 0);
  assert.match(result.diagnostics.at(-1), /catalog changed/);
});

test("rejects an apply when Project membership changes after planning", async () => {
  const store = new ReconciliationStore({ issues: [issue(1)] });
  store.changeProjectBeforeMembership = true;
  const service = new ReconciliationService({ store });

  const result = await service.reconcileMissingIssues({ apply: true });

  assert.equal(result.status, "incomplete");
  assert.equal(store.membershipAdds, 0);
  assert.match(result.diagnostics.at(-1), /membership changed/);
});

class ReconciliationStore {
  constructor({
    issues = [],
    items = [],
    failFieldSetupOnce = false,
  } = {}) {
    this.repository = REPOSITORY;
    this.projectOwner = "example";
    this.projectNumber = 1;
    this.issues = structuredClone(issues);
    this.items = structuredClone(items);
    this.failFieldSetupOnce = failFieldSetupOnce;
    this.membershipCalls = 0;
    this.membershipAdds = 0;
    this.catalogReads = 0;
    this.projectRevision = 1;
  }

  async readIssueCatalog() {
    this.catalogReads += 1;
    return {
      id: this.changeCatalogOnSecondRead && this.catalogReads > 1 ? "catalog-2" : "catalog-1",
      complete: true,
      repository: this.repository,
      issues: structuredClone(this.issues),
    };
  }

  async readCanonicalProject() {
    return {
      id: `project-${this.projectRevision}`,
      complete: true,
      items: structuredClone(this.items),
    };
  }

  async ensureIssueProjectMembership(url, { expectedProjectId } = {}) {
    this.membershipCalls += 1;
    if (this.changeProjectBeforeMembership) {
      this.changeProjectBeforeMembership = false;
      this.projectRevision += 1;
    }
    if (expectedProjectId !== `project-${this.projectRevision}`) {
      throw new Error("Project membership changed after reconciliation planning.");
    }
    const existing = this.items.find((item) => item.url === url);
    if (existing) {
      return { item: structuredClone(existing), added: false };
    }
    const source = this.issues.find((candidate) => candidate.url === url);
    const item = projectItem(source.number, { fields: {} });
    this.items.push(item);
    this.membershipAdds += 1;
    this.projectRevision += 1;
    return { item: structuredClone(item), added: true };
  }

  async ensureItemFields(itemId, fields) {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (this.failFieldSetupOnce) {
      this.failFieldSetupOnce = false;
      item.fields.owner = fields.owner;
      return {
        item: structuredClone(item),
        complete: false,
        confirmedFields: ["owner"],
        remainingFields: ["status", "priority", "autonomy"],
        error: "Project field status could not be written.",
      };
    }
    Object.assign(item.fields, fields);
    return {
      item: structuredClone(item),
      complete: true,
      confirmedFields: Object.keys(fields),
      remainingFields: [],
    };
  }
}

function issue(number, values = {}) {
  return {
    id: `issue-${number}`,
    number,
    url: `https://github.com/${REPOSITORY}/issues/${number}`,
    repository: REPOSITORY,
    state: "open",
    ...values,
  };
}

function projectItem(number, { fields = MISSING_ISSUE_INITIAL_FIELDS } = {}) {
  return {
    id: `item-${number}`,
    url: `https://github.com/${REPOSITORY}/issues/${number}`,
    contentClassification: "domain-issue",
    fields: { ...fields },
  };
}
