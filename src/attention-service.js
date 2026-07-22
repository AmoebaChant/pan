import {
  formatAnswer,
  formatNeedsHuman,
  formatNeedsHumanResolved,
  latestAttention,
  latestAnswer,
  latestNeedsHuman,
  pullRequestUrl,
} from "./needs-human.js";
import { compareBacklogItems } from "./triage-policy.js";

export class AttentionService {
  constructor({
    store,
    humanAssignee,
    assertLeadership = async () => ({ asserted: true }),
    assertExpectedState = async () => ({ matches: true }),
  }) {
    if (!store) {
      throw new TypeError("store is required");
    }
    if (typeof assertLeadership !== "function") {
      throw new TypeError("assertLeadership must be a function");
    }
    if (typeof assertExpectedState !== "function") {
      throw new TypeError("assertExpectedState must be a function");
    }
    this.store = store;
    this.humanAssignee = humanAssignee;
    this.assertLeadership = assertLeadership;
    this.assertExpectedState = assertExpectedState;
  }

  async inbox() {
    const items = await this.store.listItems();
    const entries = [];
    for (const item of items.filter(
      (candidate) => candidate.number && candidate.state !== "closed",
    )) {
      const comments = await this.store.listComments(item);
      const needsHuman = latestNeedsHuman(comments);
      if (!needsHuman && item.fields.status !== "in-review") {
        continue;
      }
      entries.push({
        id: item.number ?? item.id,
        itemId: item.id,
        title: item.title,
        status: item.fields.status,
        priority: item.fields.priority,
        issueUrl: item.url,
        kind: needsHuman?.kind ?? "review",
        prompt: needsHuman?.prompt ?? "Review the completed work.",
        locator: needsHuman?.locator,
        pullRequestUrl:
          item.linkedPullRequests?.[0]?.url ?? pullRequestUrl(comments),
      });
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    return entries.sort((left, right) =>
      compareBacklogItems(byId.get(left.itemId), byId.get(right.itemId)),
    );
  }

  async request(
    item,
    record,
    { runner, runnerAssignee, resumeAffinity, marker } = {},
  ) {
    if (!this.humanAssignee?.trim()) {
      throw new Error(
        "A human assignee must be configured before requesting attention",
      );
    }
    const comments = await this.store.listComments(item);
    let attention = latestAttention(comments);
    if (!attention || attention.resolved) {
      const request = {
        ...record,
        priorState: {
          status: item.fields.status,
          owner: item.fields.owner,
          priority: item.fields.priority,
        },
        ...(resumeAffinity
          ? { resume: { affinity: resumeAffinity } }
          : {}),
      };
      await this.#assertMutation({ operation: "attention.request", item });
      await this.store.addComment(
        item,
        [formatNeedsHuman(request), marker].filter(Boolean).join("\n\n"),
      );
      attention = { request, answer: undefined, resolved: false };
    }
    try {
      await this.#assertMutation({ operation: "attention.request", item });
      const transition = await this.store.requestHumanAttention({
        itemId: item.id,
        runner,
        runnerAssignee,
        humanAssignee: this.humanAssignee,
      });
      if (!transition.requested) {
        throw new Error(`Human attention transition failed: ${transition.reason}`);
      }
    } catch (error) {
      error.code = "PAN_ATTENTION_TRANSITION_FAILED";
      throw error;
    }
    return attention.request;
  }

  async answer(identifier, text) {
    const item = await this.#findItem(identifier);
    const comments = await this.store.listComments(item);
    const attention = latestAttention(comments);
    if (!attention || attention.resolved) {
      if (
        ["blocked", "needs-detail"].includes(item.fields.status) &&
        latestAnswer(comments)
      ) {
        await this.#assertMutation({
          operation: "attention.answer",
          phase: "recover",
          item,
        });
        await this.store.setFields(item.id, { status: "untriaged" });
        return item;
      }
      throw attentionError(
        `PAN item ${identifier} has no unresolved needs-human record`,
      );
    }
    if (!attention.answer && !attention.resolved) {
      await this.#assertAnswerState(item, attention, "record");
      await this.store.addComment(item, formatAnswer(text));
    }
    await this.#assertAnswerState(item, attention, "resolve");
    const resolution = await this.store.resolveHumanAttention({
      itemId: item.id,
      humanAssignee: this.humanAssignee,
      priority: attention.request.priorState?.priority ?? "normal",
      resumeAffinity: attention.request.resume?.affinity,
    });
    if (!resolution.resolved) {
      throw new Error(`Human attention resolution failed: ${resolution.reason}`);
    }
    if (!attention.resolved) {
      await this.store.addComment(
        item,
        formatNeedsHumanResolved("The answer was recorded and the task is ready."),
      );
    }
    return item;
  }

  async add({
    title,
    body = "",
    workstream,
    owner = "unassigned",
    priority = "normal",
    autonomy = "manual",
    requirements = [],
  }) {
    await this.#assertMutation({ operation: "attention.add" });
    return this.store.createItem({
      title,
      body,
      fields: {
        owner,
        status: "untriaged",
        priority,
        requirements,
        autonomy,
        ...(workstream ? { workstream } : {}),
      },
    });
  }

  async #findItem(identifier) {
    const items = await this.store.listItems();
    const normalized = String(identifier);
    const issueNumber = /^\d+$/.test(normalized)
      ? Number(normalized)
      : Number(normalized.match(/\/issues\/(\d+)(?:$|[?#])/)?.[1]);
    const item = items.find(
      (candidate) =>
        candidate.id === normalized ||
        candidate.url === normalized ||
        (Number.isInteger(issueNumber) && candidate.number === issueNumber),
    );
    if (!item) {
      throw new Error(`PAN item not found: ${identifier}`);
    }
    return item;
  }

  async #assertAnswerState(item, expectedAttention, phase) {
    const current = await this.#findItem(item.id);
    const comments = await this.store.listComments(current);
    const attention = latestAttention(comments);
    if (
      !attention ||
      attention.resolved ||
      !sameRequest(attention.request, expectedAttention.request) ||
      !["blocked", "needs-detail"].includes(current.fields.status)
    ) {
      throw attentionError(
        `PAN item ${item.number ?? item.id} attention state changed before ${phase}.`,
      );
    }
    await this.#assertMutation({
      operation: "attention.answer",
      phase,
      item: current,
      attention: attention.request,
    });
  }

  async #assertMutation(details) {
    const authority = await this.assertLeadership(details);
    if (!authority?.asserted) {
      const error = new Error(
        authority?.reason ?? "Leadership was not confirmed before attention mutation.",
      );
      error.code = "PAN_ATTENTION_LEADERSHIP_REQUIRED";
      throw error;
    }
    const expected = await this.assertExpectedState(details);
    if (expected?.matches === false) {
      const error = new Error(
        expected.reason ?? "Attention state no longer matches the expected state.",
      );
      error.code = "PAN_ATTENTION_NOT_ACTIONABLE";
      throw error;
    }
  }
}

function sameRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function attentionError(message) {
  const error = new Error(message);
  error.code = "PAN_ATTENTION_NOT_ACTIONABLE";
  return error;
}
