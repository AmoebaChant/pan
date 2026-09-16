import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ATTEMPT_VERSION = 1;
const RESULT_CONSUMED_VERSION = 1;
const EVIDENCE_VERSION = 1;

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function optionalBytes(filename) {
  try {
    return { present: true, bytes: await readFile(filename) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, bytes: null };
    throw error;
  }
}

async function optionalJson(filename) {
  const found = await optionalBytes(filename);
  if (!found.present) return { present: false, value: null, sha256: '' };
  try {
    return {
      present: true,
      value: JSON.parse(found.bytes.toString('utf8')),
      sha256: digest(found.bytes),
    };
  } catch {
    throw new Error(`retained migration evidence is invalid JSON: ${filename}`);
  }
}

function requireDirectChild(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the configured state root`);
  }
}

function validateAttempt(attempt, expected) {
  return !!(
    attempt
    && attempt.panRunnerAttempt === true
    && attempt.version === ATTEMPT_VERSION
    && attempt.launchId === expected.launchId
    && attempt.sessionId === expected.sessionId
    && attempt.itemId === expected.itemId
    && attempt.number === expected.number
    && attempt.machine === expected.machine
  );
}

function validateResultReceipt(receipt, attempt, resultSha256) {
  return !!(
    receipt
    && receipt.panRunnerResultConsumed === true
    && receipt.version === RESULT_CONSUMED_VERSION
    && receipt.launchId === attempt.launchId
    && receipt.sessionId === attempt.sessionId
    && receipt.itemId === attempt.itemId
    && receipt.number === attempt.number
    && receipt.resultSha256 === resultSha256
  );
}

export async function captureRetainedMigrationEvidence({
  stateRoot,
  task,
}) {
  if (!stateRoot || !path.isAbsolute(stateRoot)) {
    throw new Error('retained migration evidence requires an absolute state root');
  }
  if (
    !task
    || !Number.isInteger(task.number)
    || task.number <= 0
    || !task.itemId
    || !task.machine
    || !task.sessionId
    || task.claimGeneration
  ) {
    throw new Error('retained migration evidence requires an exact legacy task/session binding');
  }
  const sessionRoot = path.join(stateRoot, `pan-${task.number}-${task.sessionId}`);
  requireDirectChild(stateRoot, sessionRoot, 'retained session root');
  const panDir = path.join(sessionRoot, '.pan');
  const manifestPath = path.join(panDir, 'attempts.json');
  const manifestRecord = await optionalJson(manifestPath);
  if (!manifestRecord.present) {
    return {
      version: EVIDENCE_VERSION,
      localState: 'absent',
      stateRoot,
      sessionRoot,
      currentLaunchId: '',
      attemptSha256: '',
      ownerSha256: '',
      exitSha256: '',
      workerPidSha256: '',
      resultSha256: '',
      resultConsumedSha256: '',
      releaseSha256: '',
      needsHumanSha256: '',
    };
  }
  const manifest = manifestRecord.value;
  if (
    manifest?.panRunnerAttemptManifest !== true
    || manifest.version !== ATTEMPT_VERSION
    || manifest.sessionId !== task.sessionId
    || manifest.itemId !== task.itemId
    || manifest.number !== task.number
    || !Array.isArray(manifest.attempts)
    || typeof manifest.currentLaunchId !== 'string'
    || !manifest.currentLaunchId
    || !manifest.attempts.some((entry) => entry?.launchId === manifest.currentLaunchId)
  ) {
    throw new Error('retained migration attempt manifest does not match the task/session binding');
  }
  const attemptDir = path.join(panDir, 'runs', manifest.currentLaunchId);
  requireDirectChild(panDir, attemptDir, 'retained attempt directory');
  const attemptRecord = await optionalJson(path.join(attemptDir, 'attempt.json'));
  if (!attemptRecord.present || !validateAttempt(attemptRecord.value, {
    launchId: manifest.currentLaunchId,
    sessionId: task.sessionId,
    itemId: task.itemId,
    number: task.number,
    machine: String(task.machine).split('::')[0],
  })) {
    throw new Error('retained migration current attempt does not match the task/session binding');
  }
  const result = await optionalBytes(path.join(attemptDir, 'result.json'));
  const resultSha256 = result.present ? digest(result.bytes) : '';
  const consumed = await optionalJson(path.join(attemptDir, 'result-consumed.json'));
  if (
    consumed.present
    && (!result.present || !validateResultReceipt(
      consumed.value,
      attemptRecord.value,
      resultSha256,
    ))
  ) {
    throw new Error('retained migration result-consumption receipt is invalid');
  }
  const release = await optionalBytes(path.join(attemptDir, 'worker-release.json'));
  const needsHuman = await optionalJson(path.join(attemptDir, 'needs-human.json'));
  const owner = await optionalBytes(path.join(attemptDir, 'owner.json'));
  const exit = await optionalBytes(path.join(attemptDir, 'exit.json'));
  const workerPid = await optionalBytes(path.join(attemptDir, 'worker.pid'));
  return {
    version: EVIDENCE_VERSION,
    localState: 'present',
    stateRoot,
    sessionRoot,
    currentLaunchId: manifest.currentLaunchId,
    manifestSha256: manifestRecord.sha256,
    attemptSha256: attemptRecord.sha256,
    ownerSha256: owner.present ? digest(owner.bytes) : '',
    exitSha256: exit.present ? digest(exit.bytes) : '',
    workerPidSha256: workerPid.present ? digest(workerPid.bytes) : '',
    resultSha256,
    resultConsumedSha256: consumed.sha256,
    releaseSha256: release.present ? digest(release.bytes) : '',
    needsHumanSha256: needsHuman.sha256,
  };
}

export async function verifyRetainedMigrationEvidence({
  stateRoot,
  task,
  expected,
}) {
  if (!expected || expected.version !== EVIDENCE_VERSION) {
    throw new Error('retained migration authorization has unsupported evidence');
  }
  const current = await captureRetainedMigrationEvidence({ stateRoot, task });
  const fields = [
    'localState',
    'stateRoot',
    'sessionRoot',
    'currentLaunchId',
    'manifestSha256',
    'attemptSha256',
    'ownerSha256',
    'exitSha256',
    'workerPidSha256',
    'resultSha256',
    'resultConsumedSha256',
    'releaseSha256',
    'needsHumanSha256',
  ];
  for (const field of fields) {
    if ((current[field] || '') !== (expected[field] || '')) {
      throw new Error(`retained migration evidence changed: ${field}`);
    }
  }
  return current;
}
