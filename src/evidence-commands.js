import { createPanCommandResult } from "./pan-command-result.js";

export function createEvidenceCommandHandlers() {
  return {
    issues: command(async ({ context }) => {
      const catalog = await context.store.readIssueCatalog();
      const complete = catalog.complete === true;
      return createPanCommandResult({
        status: complete ? "confirmed" : "incomplete",
        operation: "evidence.issues",
        domain: context.domain,
        confirmedEffects: [
          `Read ${catalog.issues.length} Issues from the configured repository.`,
        ],
        remainingSteps: complete
          ? []
          : ["Resolve incomplete Issue evidence and read the catalog again."],
        diagnostics: catalog.diagnostics.map((entry) => entry.message),
        snapshot: {
          catalogId: catalog.id,
          capturedAt: catalog.capturedAt,
          complete,
          commentsComplete: catalog.source.comments.complete,
          relationshipsComplete: catalog.source.relationships.complete,
          excludedPullRequests: catalog.excludedPullRequests,
        },
      });
    }),
  };
}

function command(handler) {
  return Object.assign(handler, { specification: {} });
}
