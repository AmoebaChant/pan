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

/**
 * Completes reviewed work only after its linked pull request is independently
 * confirmed as merged, preserving each external effect as a retryable receipt.
 */
export class MergedPullRequestReconciliationService {
  constructor({
    store,
    assertLeadership = async () => ({ asserted: true }),
  } = {}) {
    if (
      !store?.readCanonicalProject ||
      !store?.confirmMergedPullRequest ||
      !store?.confirmMergedPullRequestStatus ||
      !store?.confirmMergedIssueClosure
    ) {
      throw new TypeError("store must provide merged pull request reconciliation primitives");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    this.store = store;
    this.assertLeadership = assertLeadership;
  }

  async planMergedPullRequests() {
    const project = await this.store.readCanonicalProject();
    if (project.complete !== true) {
      return {
        repository: this.store.repository,
        projectOwner: this.store.projectOwner,
        projectNumber: this.store.projectNumber,
        complete: false,
        projectId: project.id,
        candidates: [],
        exclusions: [],
        blockers: [
          "Project evidence is incomplete; merged pull requests cannot be reconciled safely.",
          ...(project.diagnostics ?? []),
        ],
      };
    }
    const candidates = [];
    const exclusions = [];
    for (const item of project.items) {
      if (
        item.contentClassification !== "domain-issue" ||
        !(
          item.fields?.status === "in-review" ||
          (item.fields?.status === "done" && item.state?.toLowerCase() !== "closed")
        )
      ) {
        continue;
      }
      const pullRequest = mergedPullRequest(item);
      if (!pullRequest) {
        exclusions.push(
          `Excluded in-review Issue #${item.number ?? item.id}: no confirmed merged linked pull request.`,
        );
        continue;
      }
      candidates.push(candidateFrom(item, pullRequest));
    }
    return {
      repository: this.store.repository,
      projectOwner: this.store.projectOwner,
      projectNumber: this.store.projectNumber,
      complete: true,
      projectId: project.id,
      candidates,
      exclusions,
      blockers: [],
    };
  }

  async reconcileMergedPullRequests({ apply = false } = {}) {
    if (typeof apply !== "boolean") {
      throw new TypeError("apply must be a boolean");
    }
    const plan = await this.planMergedPullRequests();
    if (!plan.complete) {
      return mergedReceipt({
        status: "incomplete",
        plan,
        diagnostics: plan.blockers,
        remainingSteps: [
          "Resolve incomplete Project evidence and retry merged pull request reconciliation.",
        ],
      });
    }
    if (!apply) {
      return mergedReceipt({
        plan,
        receipts: plan.candidates.map((candidate) =>
          receiptFor(candidate, "planned", "planned"),
        ),
        confirmedEffects: plan.candidates.map(
          (candidate) =>
            `Planned completion of Issue #${candidate.issueNumber} after ${candidate.pullRequestUrl} was confirmed merged.`,
        ),
        diagnostics: plan.exclusions,
        remainingSteps: [],
      });
    }

    const receipts = [];
    const confirmedEffects = [];
    const diagnostics = [...plan.exclusions];
    for (const candidate of plan.candidates) {
      const evidence = await this.store.confirmMergedPullRequest(candidate.itemId, {
        expectedIssueUrl: candidate.issueUrl,
        expectedPullRequestUrl: candidate.pullRequestUrl,
      });
      if (!evidence.confirmed) {
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [...diagnostics, evidence.reason],
          remaining: candidate,
        });
      }

      const statusAuthority = await this.assertLeadership();
      if (!statusAuthority?.asserted) {
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [
            ...diagnostics,
            statusAuthority?.reason ??
              "Leadership was not confirmed before status completion.",
          ],
          remaining: candidate,
        });
      }
      let status;
      try {
        status = await this.store.confirmMergedPullRequestStatus(
          candidate.itemId,
          {
            expectedIssueUrl: candidate.issueUrl,
            expectedPullRequestUrl: candidate.pullRequestUrl,
          },
        );
      } catch (error) {
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [...diagnostics, message(error)],
          remaining: candidate,
        });
      }
      if (!status.confirmed) {
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [...diagnostics, status.reason],
          remaining: candidate,
        });
      }
      confirmedEffects.push(
        `Confirmed Project item ${candidate.itemId} is done for Issue #${candidate.issueNumber}.`,
      );

      const closeAuthority = await this.assertLeadership();
      if (!closeAuthority?.asserted) {
        receipts.push(receiptFor(candidate, "confirmed", "pending"));
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [
            ...diagnostics,
            closeAuthority?.reason ?? "Leadership was not confirmed before Issue closure.",
          ],
          remaining: candidate,
        });
      }

      let closure;
      try {
        closure = await this.store.confirmMergedIssueClosure(candidate.itemId, {
          expectedIssueUrl: candidate.issueUrl,
        });
      } catch (error) {
        receipts.push(receiptFor(candidate, "confirmed", "pending"));
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [...diagnostics, message(error)],
          remaining: candidate,
        });
      }
      if (!closure.confirmed) {
        receipts.push(receiptFor(candidate, "confirmed", "pending"));
        return incompleteMergedReceipt({
          plan,
          receipts,
          confirmedEffects,
          diagnostics: [...diagnostics, closure.reason],
          remaining: candidate,
        });
      }
      receipts.push(
        receiptFor(
          candidate,
          "confirmed",
          closure.alreadyClosed ? "already-closed" : "confirmed",
        ),
      );
      confirmedEffects.push(
        closure.alreadyClosed
          ? `Confirmed Issue #${candidate.issueNumber} was already closed.`
          : `Confirmed Issue #${candidate.issueNumber} is closed.`,
      );
    }
    return mergedReceipt({
      plan,
      receipts,
      confirmedEffects,
      diagnostics,
      remainingSteps: [],
    });
  }
}

function mergedPullRequest(item) {
  return item.linkedPullRequests?.find(
    (pullRequest) =>
      typeof pullRequest?.url === "string" &&
      pullRequest.url &&
      (pullRequest.state?.toLowerCase() === "merged" || Boolean(pullRequest.mergedAt)),
  );
}

function candidateFrom(item, pullRequest) {
  return {
    itemId: item.id,
    issueNumber: item.number,
    issueUrl: item.url,
    pullRequestUrl: pullRequest.url,
  };
}

function receiptFor(candidate, projectStatus, issueStatus) {
  return {
    itemId: candidate.itemId,
    issueNumber: candidate.issueNumber,
    issueUrl: candidate.issueUrl,
    pullRequestUrl: candidate.pullRequestUrl,
    projectStatus,
    issueStatus,
  };
}

function incompleteMergedReceipt({
  plan,
  receipts,
  confirmedEffects,
  diagnostics,
  remaining,
}) {
  return mergedReceipt({
    status: "incomplete",
    plan,
    receipts,
    confirmedEffects,
    diagnostics,
    remainingSteps: [
      `Confirm Project completion and close Issue #${remaining.issueNumber} for ${remaining.pullRequestUrl}.`,
    ],
  });
}

function mergedReceipt({
  status = "confirmed",
  plan,
  receipts = [],
  confirmedEffects = [],
  diagnostics = [],
  remainingSteps,
}) {
  return createPanCommandResult({
    status,
    operation: "reconcile.merged-prs",
    domain: {
      repository: plan.repository ?? "",
      projectOwner: plan.projectOwner ?? "",
      projectNumber: plan.projectNumber ?? 1,
    },
    receipts,
    confirmedEffects:
      confirmedEffects.length > 0
        ? confirmedEffects
        : status === "confirmed"
          ? ["No in-review work has a confirmed merged linked pull request."]
          : [],
    remainingSteps,
    diagnostics,
    recovery: {
      safe: true,
      steps:
        status === "confirmed"
          ? []
          : ["Retry reconciliation; confirmed Project and Issue effects are reused."],
    },
    snapshot: { projectId: plan.projectId },
    expectedState: { projectMembership: plan.projectId },
  });
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
