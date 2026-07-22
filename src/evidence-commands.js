import path from "node:path";

import { createPanCommandResult } from "./pan-command-result.js";
import { PortfolioSnapshotBuilder } from "./portfolio-snapshot.js";
import { RunnerProfileSource } from "./runner-profile-source.js";
import { WorkstreamStore } from "./workstream-store.js";

export function createEvidenceCommandHandlers({
  portfolioBuilderFactory = (context) =>
    new PortfolioSnapshotBuilder({
      projectSource: context.store,
      issueCatalogSource: context.store,
      workstreamSource: new WorkstreamStore({
        repositoryPath: context.domain.path,
      }),
      runnerSource: new RunnerProfileSource({
        directory: path.join(context.domain.path, "runners"),
      }),
    }),
} = {}) {
  return {
    issues: command(async ({ context }) => {
      const catalog = await context.store.readIssueCatalog();
      const complete = catalog.complete === true;
      return createPanCommandResult({
        status: complete ? "confirmed" : "incomplete",
        operation: "evidence.issues",
        domain: commandDomain(context.domain),
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
    portfolio: command(async ({ context }) => {
      const snapshot = await portfolioBuilderFactory(context).build();
      const complete = snapshot.complete === true;
      return createPanCommandResult({
        status: complete ? "confirmed" : "incomplete",
        operation: "evidence.portfolio",
        domain: commandDomain(context.domain),
        confirmedEffects: [
          `Read ${snapshot.project.items.length} Project items and ${snapshot.issueCatalog.id === "unavailable" ? 0 : snapshot.dossiers.filter((dossier) => dossier.evidenceAvailable.issue).length} configured-domain Issues.`,
        ],
        remainingSteps: complete
          ? []
          : ["Resolve incomplete portfolio evidence and read the snapshot again."],
        diagnostics: snapshot.diagnostics.map((entry) => entry.message),
        snapshot: {
          snapshotId: snapshot.id,
          version: snapshot.version,
          complete,
          usableForMutation: snapshot.usableForMutation,
        },
        expectedState: snapshot.expectedState,
      });
    }),
  };
}

function command(handler) {
  return Object.assign(handler, { specification: {} });
}

function commandDomain({ repository, projectOwner, projectNumber }) {
  return { repository, projectOwner, projectNumber };
}
