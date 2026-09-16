#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { exactCurrentActionDetail } from './pan-task-model.js';
import { parseMigrationAuthorizations } from './pan-lifecycle-migration.js';
import { captureRetainedMigrationEvidence } from './pan-lifecycle-retained-evidence.js';

const CLASSIFICATIONS = new Set([
  'verifiedRetainedCheckpoint',
  'verifiedRetainedReview',
  'verifiedRetainedHold',
]);

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: 'string' },
      decisions: { type: 'string' },
      'state-root': { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  for (const field of ['plan', 'decisions', 'state-root', 'output']) {
    if (!values[field] || !path.isAbsolute(values[field])) {
      throw new Error(`--${field} must be an absolute path`);
    }
  }
  return {
    plan: values.plan,
    decisions: values.decisions,
    stateRoot: values['state-root'],
    output: values.output,
  };
}

function exactDecision(value) {
  if (
    !value
    || typeof value.itemId !== 'string'
    || !value.itemId
    || !CLASSIFICATIONS.has(value.classification)
    || typeof value.action !== 'string'
    || !value.action
    || !['checkpointed', 'paused'].includes(value.targetWorkerState)
  ) {
    throw new Error('retained migration decision is incomplete');
  }
  return {
    itemId: value.itemId,
    classification: value.classification,
    action: value.action,
    detail: exactCurrentActionDetail(
      value.detail,
      `retained migration decision detail for ${value.itemId}`,
    ),
    targetWorkerState: value.targetWorkerState,
  };
}

function expectedString(action, field) {
  const value = action.expected?.[field];
  if (value == null) return '';
  return String(value);
}

export async function buildRetainedMigrationAuthorization({
  plan,
  decisions,
  stateRoot,
}) {
  if (
    plan?.format !== 'pan-lifecycle-migration-plan'
    || plan.version !== 1
    || !Array.isArray(plan.actions)
  ) {
    throw new Error('retained migration authorization requires a lifecycle migration plan');
  }
  if (
    decisions?.format !== 'pan-retained-migration-decisions'
    || decisions.version !== 1
    || !Array.isArray(decisions.items)
  ) {
    throw new Error('retained migration decisions are invalid');
  }
  const actions = new Map(plan.actions.map((action) => [action.itemId, action]));
  const items = [];
  for (const raw of decisions.items) {
    const decision = exactDecision(raw);
    const action = actions.get(decision.itemId);
    if (!action || action.action !== 'requires-cutover-hold') {
      throw new Error(`retained migration decision ${decision.itemId} is not an exact cutover hold`);
    }
    const expected = action.expected;
    const runtimeEvidence = await captureRetainedMigrationEvidence({
      stateRoot,
      task: {
        number: expected.number,
        itemId: decision.itemId,
        machine: expected.machine,
        sessionId: expected.sessionId,
        claimGeneration: expected.claimGeneration,
      },
    });
    if (
      decision.classification === 'verifiedRetainedCheckpoint'
      && !runtimeEvidence.needsHumanSha256
    ) {
      throw new Error(`retained checkpoint ${decision.itemId} has no exact needs-human evidence`);
    }
    if (
      decision.classification === 'verifiedRetainedReview'
      && (
        !runtimeEvidence.resultSha256
        || !runtimeEvidence.resultConsumedSha256
      )
    ) {
      throw new Error(`retained review ${decision.itemId} lacks exact consumed-result evidence`);
    }
    if (
      decision.classification === 'verifiedRetainedHold'
      && runtimeEvidence.localState !== 'absent'
    ) {
      throw new Error(`retained hold ${decision.itemId} must bind the reviewed missing local state`);
    }
    items.push({
      itemId: decision.itemId,
      classification: decision.classification,
      number: expected.number,
      projection: expectedString(action, 'projection'),
      revision: expectedString(action, 'revision'),
      playbook: expectedString(action, 'playbook'),
      dependencies: expectedString(action, 'dependencies'),
      status: expectedString(action, 'status'),
      owner: expectedString(action, 'owner'),
      issueState: expectedString(action, 'issueState'),
      issueStateReason: expectedString(action, 'issueStateReason'),
      workerState: expectedString(action, 'workerState'),
      machine: expectedString(action, 'machine'),
      sessionId: expectedString(action, 'sessionId'),
      claimGeneration: expectedString(action, 'claimGeneration'),
      claimedBy: expectedString(action, 'claimedBy'),
      leaseUntil: expectedString(action, 'leaseUntil'),
      needsHumanSince: expectedString(action, 'needsHumanSince'),
      resourceSemantics: expectedString(action, 'resourceSemantics'),
      sourceExecutionAuthorized: expectedString(action, 'executionAuthorized') || 'no',
      action: decision.action,
      detail: decision.detail,
      targetWorkerState: decision.targetWorkerState,
      executionAuthorized: false,
      verifiedDeadProcess: true,
      verifiedWritersStopped: true,
      stateRoot,
      runtimeEvidence,
    });
  }
  const authorization = {
    format: 'pan-lifecycle-migration-authorization',
    version: 1,
    items,
  };
  parseMigrationAuthorizations(authorization);
  return authorization;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const authorization = await buildRetainedMigrationAuthorization({
    plan: JSON.parse(await readFile(options.plan, 'utf8')),
    decisions: JSON.parse(await readFile(options.decisions, 'utf8')),
    stateRoot: options.stateRoot,
  });
  await writeFile(options.output, `${JSON.stringify(authorization, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${options.output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`pan-lifecycle-authorize-retained: ${error.message}\n`);
    process.exitCode = 1;
  });
}
