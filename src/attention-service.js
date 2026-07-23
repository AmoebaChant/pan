import { formatNeedsHuman, latestAttention } from "./needs-human.js";

export class AttentionService {
  constructor({ store, humanAssignee }) {
    if (!store) {
      throw new TypeError("store is required");
    }
    this.store = store;
    this.humanAssignee = humanAssignee;
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
}
