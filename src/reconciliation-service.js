import { createPanCommandResult } from "./pan-command-result.js";

export const MISSING_ISSUE_INITIAL_FIELDS = Object.freeze({
  owner: "unassigned",
  status: "untriaged",
  priority: "normal",
  autonomy: "manual",
});

/**
 * Reconciles open domain Issues that have not yet been registered in the Project.
 */
export class ReconciliationService {
  constructor({
    store,
    assertLeadership = async () => ({ asserted: true }),
    isEligibleIssue = () => true,
  } = {}) {
    if (
      !store?.readIssueCatalog ||
      !store?.readCanonicalProject ||
      !store?.ensureIssueProjectMembership ||
      !store?.ensureItemFields
    ) {
      throw new TypeError("store must provide reconciliation primitives");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    if (typeof isEligibleIssue !== "function") {
      throw new TypeError("isEligibleIssue must be a function");
    }
    this.store = store;
    this.assertLeadership = assertLeadership;
    this.isEligibleIssue = isEligibleIssue;
  }

  async reconcileMissingIssues({ apply = false } = {}) {
    if (typeof apply !== "boolean") {
      throw new TypeError("apply must be a boolean");
    }
    const plan = await this.planMissingIssues();
    if (!plan.complete) {
      return receipt({
        status: "incomplete",
        plan,
        diagnostics: plan.blockers,
        remainingSteps: [
          "Resolve incomplete Issue or Project evidence and reconcile again.",
        ],
      });
    }
    if (!apply) {
      return receipt({
        plan,
      confirmedEffects: plan.additions.map(
        ({ issue, membershipMissing }) =>
          membershipMissing
            ? `Planned Project registration for Issue #${issue.number}.`
            : `Planned initial field confirmation for Issue #${issue.number}.`,
      ),
      diagnostics: plan.exclusions,
      remainingSteps: [],
      });
    }

    const confirmedEffects = [];
    const diagnostics = [...plan.exclusions];
    let expectedProjectId = plan.projectId;
    for (let index = 0; index < plan.additions.length; index += 1) {
      const addition = plan.additions[index];
      const authority = await this.assertLeadership();
      if (!authority?.asserted) {
        return incompleteReceipt({
          plan,
          confirmedEffects,
          diagnostics: [
            ...diagnostics,
            authority?.reason ?? "Leadership was not confirmed before Project registration.",
          ],
          remaining: plan.additions.slice(index),
        });
      }

      const currentIssue = await this.#revalidateIssue(addition.issue, plan.catalogId);
      if (!currentIssue.issue) {
        return incompleteReceipt({
          plan,
          confirmedEffects,
          diagnostics: [...diagnostics, currentIssue.reason],
          remaining: plan.additions.slice(index),
        });
      }

      let membership;
      try {
        membership = await this.store.ensureIssueProjectMembership(
          currentIssue.issue.url,
          { expectedProjectId },
        );
      } catch (error) {
        return incompleteReceipt({
          plan,
          confirmedEffects,
          diagnostics: [...diagnostics, message(error)],
          remaining: plan.additions.slice(index),
        });
      }
      if (membership.added) {
        confirmedEffects.push(
          `Added existing Issue #${currentIssue.issue.number} to the Project as ${membership.item.id}.`,
        );
      } else {
        confirmedEffects.push(
          `Confirmed Issue #${currentIssue.issue.number} is already registered as ${membership.item.id}.`,
        );
      }

      const fieldAuthority = await this.assertLeadership();
      if (!fieldAuthority?.asserted) {
        return incompleteReceipt({
          plan,
          confirmedEffects,
          diagnostics: [
            ...diagnostics,
            fieldAuthority?.reason ??
              "Leadership was not confirmed before Project field initialization.",
          ],
          remaining: plan.additions.slice(index),
        });
      }
      const fields = await this.store.ensureItemFields(
        membership.item.id,
        addition.initialFields,
      );
      for (const key of fields.confirmedFields) {
        confirmedEffects.push(
          `Confirmed ${key} for Project item ${membership.item.id}.`,
        );
      }
      if (!fields.complete) {
        return incompleteReceipt({
          plan,
          confirmedEffects,
          diagnostics: [...diagnostics, fields.error ?? "Project field setup was not confirmed."],
          remaining: plan.additions.slice(index),
        });
      }

      expectedProjectId = (await this.store.readCanonicalProject()).id;
    }

    return receipt({
      plan,
      confirmedEffects,
      diagnostics,
      remainingSteps: [],
    });
  }

  async planMissingIssues() {
    const [catalog, project] = await Promise.all([
      this.store.readIssueCatalog(),
      this.store.readCanonicalProject(),
    ]);
    const blockers = [];
    if (catalog.complete !== true) {
      blockers.push("The Issue catalog is incomplete.");
    }
    if (project.complete !== true) {
      blockers.push("Project membership evidence is incomplete.");
    }
    if (blockers.length > 0) {
      return {
        repository: this.store.repository,
        projectOwner: this.store.projectOwner,
        projectNumber: this.store.projectNumber,
        complete: false,
        catalogId: catalog.id,
        projectId: project.id,
        additions: [],
        exclusions: [],
        blockers,
      };
    }
    const projectItems = new Map(
      project.items
        .filter((item) => item.contentClassification === "domain-issue")
        .map((item) => [item.url, item]),
    );
    const additions = [];
    const exclusions = [];
    for (const issue of catalog.issues) {
      if (!eligibleIssue(issue, catalog.repository)) {
        exclusions.push(`Excluded unsupported Issue evidence for #${issue?.number ?? "unknown"}.`);
        continue;
      }
      if (!this.isEligibleIssue(issue)) {
        exclusions.push(`Excluded Issue #${issue.number} by domain policy.`);
        continue;
      }
      const projectItem = projectItems.get(issue.url);
      if (!projectItem || needsInitialFields(projectItem)) {
        additions.push({
          issue: { ...issue },
          membershipMissing: !projectItem,
          initialFields: { ...MISSING_ISSUE_INITIAL_FIELDS },
        });
      }
    }
    return {
      repository: this.store.repository,
      projectOwner: this.store.projectOwner,
      projectNumber: this.store.projectNumber,
      complete: true,
      catalogId: catalog.id,
      projectId: project.id,
      additions,
      exclusions,
      blockers: [],
    };
  }

  async #revalidateIssue(expected, catalogId) {
    const catalog = await this.store.readIssueCatalog();
    if (catalog.complete !== true) {
      return {
        reason: "The Issue catalog became incomplete before Project registration.",
      };
    }
    if (catalog.id !== catalogId) {
      return {
        reason: "The Issue catalog changed after reconciliation planning.",
      };
    }
    const issue = catalog.issues.find((candidate) => candidate.number === expected.number);
    if (
      !issue ||
      !eligibleIssue(issue, catalog.repository) ||
      issue.id !== expected.id ||
      issue.url !== expected.url ||
      issue.state !== expected.state
    ) {
      return {
        reason: `Issue #${expected.number} changed or is no longer eligible.`,
      };
    }
    return { issue };
  }
}

function eligibleIssue(issue, repository) {
  return (
    issue?.repository === repository &&
    issue.state === "open" &&
    !issue.pull_request &&
    Number.isInteger(issue.number) &&
    issue.number > 0 &&
    typeof issue.id === "string" &&
    typeof issue.url === "string" &&
    issue.url.length > 0
  );
}

function needsInitialFields(item) {
  const fields = item.fields ?? {};
  const values = Object.entries(MISSING_ISSUE_INITIAL_FIELDS);
  return (
    values.some(([key]) => !fields[key]) &&
    values.every(([key, value]) => !fields[key] || fields[key] === value)
  );
}

function incompleteReceipt({
  plan,
  confirmedEffects,
  diagnostics,
  remaining,
}) {
  return receipt({
    status: "incomplete",
    plan,
    confirmedEffects,
    diagnostics,
    remainingSteps: remaining.map(
      ({ issue }) =>
        `Reconcile Issue #${issue.number} from its existing Project item or Issue URL.`,
    ),
  });
}

function receipt({
  status = "confirmed",
  plan,
  confirmedEffects = [],
  diagnostics = [],
  remainingSteps,
}) {
  return createPanCommandResult({
    status,
    operation: "reconcile.missing-issues",
    domain: {
      repository: plan.repository,
      projectOwner: plan.projectOwner,
      projectNumber: plan.projectNumber,
    },
    confirmedEffects:
      confirmedEffects.length > 0
        ? confirmedEffects
        : status === "confirmed"
          ? ["No missing eligible Issues require Project registration."]
          : [],
    remainingSteps,
    diagnostics,
    recovery: {
      safe: true,
      steps:
        status === "confirmed"
          ? []
          : ["Retry reconciliation; existing Project registrations will be reused."],
    },
    snapshot: {
      catalogId: plan.catalogId,
      projectId: plan.projectId,
    },
    expectedState: {
      issueCatalog: plan.catalogId,
      projectMembership: plan.projectId,
    },
  });
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
