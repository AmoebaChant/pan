import {
  formatAnswer,
  latestAnswer,
  latestNeedsHuman,
  pullRequestUrl,
} from "./needs-human.js";
import { compareBacklogItems } from "./triage-policy.js";

export class AttentionService {
  constructor({ store }) {
    if (!store) {
      throw new TypeError("store is required");
    }
    this.store = store;
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
        pullRequestUrl: pullRequestUrl(comments),
      });
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    return entries.sort((left, right) =>
      compareBacklogItems(byId.get(left.itemId), byId.get(right.itemId)),
    );
  }

  async answer(identifier, text) {
    const item = await this.#findItem(identifier);
    const comments = await this.store.listComments(item);
    const pending = latestNeedsHuman(comments);
    if (!pending) {
      if (
        ["blocked", "needs-detail"].includes(item.fields.status) &&
        latestAnswer(comments)
      ) {
        await this.store.setFields(item.id, { status: "untriaged" });
        return item;
      }
      throw new Error(`PAN item ${identifier} has no unresolved needs-human record`);
    }
    await this.store.addComment(item, formatAnswer(text));
    if (["blocked", "needs-detail"].includes(item.fields.status)) {
      await this.store.setFields(item.id, { status: "untriaged" });
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
}
