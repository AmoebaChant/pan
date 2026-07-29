import {
  formatNeedsHuman,
  formatNeedsHumanResolved,
  latestAttention,
} from "./needs-human.js";

export class AttentionService {
  constructor({ store }) {
    if (!store) {
      throw new TypeError("store is required");
    }
    this.store = store;
  }

  async request(item, record, { runner, resumeAffinity, marker } = {}) {
    const comments = await this.store.listComments(item);
    let attention = latestAttention(comments);
    if (!attention || attention.resolved) {
      const request = {
        ...record,
        ...(resumeAffinity
          ? { resume: { affinity: resumeAffinity } }
          : {}),
      };
      await this.store.addComment(
        item,
        [formatNeedsHuman(request), marker].filter(Boolean).join("\n\n"),
      );
      attention = { request, answer: undefined, resolved: false };
    }
    try {
      const transition = await this.store.requestHumanAttention({
        itemId: item.id,
        runner,
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

  async resolve(item, { runner, reason } = {}) {
    let transition;
    try {
      transition = await this.store.resolveHumanAttention({
        itemId: item.id,
        runner,
      });
      if (!transition.resolved) {
        throw new Error(
          `Human attention resolution failed: ${transition.reason}`,
        );
      }
    } catch (error) {
      error.code = "PAN_ATTENTION_TRANSITION_FAILED";
      throw error;
    }
    const comments = await this.store.listComments(item);
    const attention = latestAttention(comments);
    if (attention && !attention.resolved) {
      await this.store.addComment(
        item,
        formatNeedsHumanResolved(
          reason ?? "Answered in the worker's terminal; the worker continued.",
        ),
      );
    }
    return transition.item;
  }
}
