import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ATTEMPT_VERSION = 1;
const ATTEMPT_MANIFEST = 'attempts.json';
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDir(dirPath, options = {}) {
  await mkdir(dirPath, { mode: PRIVATE_DIR_MODE, ...options });
  if (process.platform !== 'win32') {
    const st = await lstat(dirPath);
    if (st.isDirectory() && !st.isSymbolicLink()) await chmod(dirPath, PRIVATE_DIR_MODE);
  }
}

export async function privateWriteFile(filePath, data, options = {}) {
  await writeFile(filePath, data, { mode: PRIVATE_FILE_MODE, ...options });
  if (process.platform !== 'win32') await chmod(filePath, PRIVATE_FILE_MODE);
}

export function defaultStateRoot(
  machine,
  identity,
  {
    platform = process.platform,
    env = process.env,
    home = os.homedir(),
  } = {},
) {
  const label = String(machine || 'machine')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'machine';
  const suffix = createHash('sha256').update(String(identity || machine || 'pan')).digest('hex').slice(0, 12);
  const namespace = `${label}-${suffix}`;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, 'Pan', namespace);
  }
  if (platform === 'darwin') {
    return path.posix.join(home, 'Library', 'Application Support', 'Pan', namespace);
  }
  const base = env.XDG_STATE_HOME || path.posix.join(home, '.local', 'state');
  return path.posix.join(base, 'pan', namespace);
}

export function isLaunchId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function atomicWriteJson(filePath, value) {
  await ensurePrivateDir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.new`;
  try {
    await privateWriteFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(tmp, filePath);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readJson(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, value: null };
    return { present: true, value: null, error };
  }
  try {
    return { present: true, value: JSON.parse(raw) };
  } catch (error) {
    return { present: true, value: null, error };
  }
}

function runCapture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    return null;
  }
}

function linuxStartTicks(stat) {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fieldsAfterComm = stat.slice(close + 1).trim().split(/\s+/);
  const value = fieldsAfterComm[19];
  return /^\d+$/.test(value || '') ? value : null;
}

export function windowsProcessIdentityScript(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error('Windows process identity requires a positive integer PID');
  }
  return `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";` +
    `if($null -eq $p){exit 3};` +
    `$ticks=([DateTime]$p.CreationDate).ToUniversalTime().Ticks;` +
    `$record=[ordered]@{processStart=([Int64]$ticks).ToString(` +
    `[Globalization.CultureInfo]::InvariantCulture);command=[string]$p.CommandLine};` +
    `[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $record))`;
}

export function parseWindowsProcessIdentityOutput(stdout) {
  let record;
  try {
    record = JSON.parse(String(stdout));
  } catch {
    throw new Error('Windows process identity output is not valid JSON');
  }
  if (
    !record
    || typeof record.processStart !== 'string'
    || !/^\d+$/.test(record.processStart)
    || typeof record.command !== 'string'
  ) {
    throw new Error('Windows process identity output is incomplete');
  }
  return {
    identity: `win32:${record.processStart}`,
    command: record.command,
  };
}

export async function inspectProcess(
  pid,
  {
    platform = process.platform,
    read = readFile,
    run = runCapture,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'dead', reason: 'invalid PID' };
  }
  const exists = processExists(pid);
  if (exists === false) return { state: 'dead', reason: 'PID does not exist' };
  if (exists == null) return { state: 'unknown', reason: 'PID liveness could not be checked' };

  try {
    if (platform === 'linux') {
      const [stat, bootId, command] = await Promise.all([
        read(`/proc/${pid}/stat`, 'utf8'),
        read('/proc/sys/kernel/random/boot_id', 'utf8'),
        read(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      ]);
      const ticks = linuxStartTicks(stat);
      if (!ticks || !bootId.trim()) {
        return { state: 'unknown', reason: 'Linux process start identity is unreadable' };
      }
      return {
        state: 'live',
        identity: `linux:${bootId.trim()}:${ticks}`,
        command: command.split('\0').filter(Boolean).join(' '),
      };
    }

    if (platform === 'darwin') {
      const start = await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
      if (start.code !== 0 || !start.stdout.trim()) {
        return processExists(pid) === false
          ? { state: 'dead', reason: 'PID exited during inspection' }
          : { state: 'unknown', reason: 'macOS process start identity is unreadable' };
      }
      const command = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
      return {
        state: 'live',
        identity: `darwin:${start.stdout.trim()}`,
        command: command.code === 0 ? command.stdout.trim() : '',
      };
    }

    if (platform === 'win32') {
      const script = windowsProcessIdentityScript(pid);
      const result = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      if (result.code === 3) return { state: 'dead', reason: 'PID does not exist' };
      if (result.code !== 0) {
        return { state: 'unknown', reason: 'Windows process start identity is unreadable' };
      }
      const observed = parseWindowsProcessIdentityOutput(result.stdout);
      return { state: 'live', ...observed };
    }
  } catch {
    if (processExists(pid) === false) return { state: 'dead', reason: 'PID exited during inspection' };
    return { state: 'unknown', reason: `process identity is unreadable on ${platform}` };
  }

  return { state: 'unknown', reason: `process identity is unsupported on ${platform}` };
}

function attemptMetadataValid(attempt, expected) {
  return !!attempt
    && attempt.panRunnerAttempt === true
    && attempt.version === ATTEMPT_VERSION
    && isLaunchId(attempt.launchId)
    && attempt.launchId === expected.launchId
    && attempt.sessionId === expected.sessionId
    && attempt.itemId === expected.itemId
    && attempt.number === expected.number
    && attempt.machine === expected.machine
    && attempt.identity === expected.identity
    && typeof attempt.isolated === 'boolean'
    && (attempt.slot == null || typeof attempt.slot === 'string')
    && typeof attempt.workingDir === 'string'
    && attempt.workingDir.length > 0;
}

function ownerValid(owner, launchId) {
  return !!owner
    && owner.panRunnerOwner === true
    && owner.version === ATTEMPT_VERSION
    && owner.launchId === launchId
    && Number.isInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.processStart === 'string'
    && owner.processStart.length > 0;
}

function manifestBinding(metadata) {
  return {
    sessionId: metadata.sessionId,
    itemId: metadata.itemId,
    number: metadata.number,
    machine: metadata.machine,
    identity: metadata.identity,
  };
}

function manifestValid(manifest, expected) {
  return !!manifest
    && manifest.panRunnerAttemptManifest === true
    && manifest.version === ATTEMPT_VERSION
    && manifest.sessionId === expected.sessionId
    && manifest.itemId === expected.itemId
    && manifest.number === expected.number
    && manifest.machine === expected.machine
    && manifest.identity === expected.identity
    && Array.isArray(manifest.attempts)
    && manifest.attempts.every((entry) =>
      !!entry
      && isLaunchId(entry.launchId)
      && typeof entry.createdAt === 'string'
      && entry.createdAt.length > 0
      && (entry.creationKey == null || (
        typeof entry.creationKey === 'string'
        && entry.creationKey.length > 0
      ))
      && (entry.kind == null || entry.kind === 'launch')
    )
    && new Set(manifest.attempts.map((entry) => entry.launchId)).size === manifest.attempts.length
    && new Set(
      manifest.attempts
        .filter((entry) => entry.creationKey != null)
        .map((entry) => entry.creationKey),
    ).size === manifest.attempts.filter((entry) => entry.creationKey != null).length
    && (
      manifest.currentLaunchId === null
      || (
        isLaunchId(manifest.currentLaunchId)
        && manifest.attempts.some((entry) => entry.launchId === manifest.currentLaunchId)
      )
    );
}

export async function ensureAttemptManifest(sessionPanDir, metadata) {
  const runsDir = path.join(sessionPanDir, 'runs');
  await ensurePrivateDir(runsDir, { recursive: true });
  const runsStat = await lstat(runsDir);
  if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) {
    throw new Error(`attempt runs path is not a real directory: ${runsDir}`);
  }

  const manifestPath = path.join(sessionPanDir, ATTEMPT_MANIFEST);
  const existing = await readJson(manifestPath);
  if (existing.present) {
    if (!manifestValid(existing.value, metadata)) {
      throw new Error(`attempt manifest is unreadable or mismatched: ${manifestPath}`);
    }
    return existing.value;
  }

  const manifest = {
    panRunnerAttemptManifest: true,
    version: ATTEMPT_VERSION,
    ...manifestBinding(metadata),
    attempts: [],
    currentLaunchId: null,
  };
  await atomicWriteJson(manifestPath, manifest);
  return manifest;
}

export async function inspectAttempt(
  attemptDir,
  expected,
  {
    inspect = inspectProcess,
    allowLegacySignalDir = () => false,
  } = {},
) {
  const launchId = path.basename(attemptDir);
  if (!isLaunchId(launchId)) return null;

  let st;
  try {
    st = await lstat(attemptDir);
  } catch (error) {
    return {
      launchId,
      attemptDir,
      signalDir: attemptDir,
      status: 'uncertain',
      reason: `attempt directory is missing or unreadable: ${error.message}`,
    };
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    return {
      launchId,
      attemptDir,
      signalDir: attemptDir,
      status: 'uncertain',
      reason: 'attempt path is not a real directory',
    };
  }

  const attemptRead = await readJson(path.join(attemptDir, 'attempt.json'));
  const attempt = attemptRead.value;
  if (!attemptMetadataValid(attempt, { ...expected, launchId })) {
    return {
      launchId,
      attemptDir,
      signalDir: attemptDir,
      status: 'uncertain',
      reason: 'attempt metadata is missing, unreadable, or mismatched',
    };
  }

  if (
    attempt.legacySignalDir != null
    && (
      attempt.migrated !== true
      || typeof attempt.legacySignalDir !== 'string'
      || !allowLegacySignalDir(attempt.legacySignalDir, attempt)
    )
  ) {
    return {
      launchId,
      attemptDir,
      signalDir: attemptDir,
      attempt,
      status: 'uncertain',
      reason: 'legacy signal directory is not an approved migration source',
    };
  }
  const signalDir = attempt.legacySignalDir || attemptDir;
  const exitRead = await readJson(path.join(attemptDir, 'exit.json'));
  const validExit = (
    exitRead.value?.panRunnerExit === true
    && exitRead.value?.version === ATTEMPT_VERSION
    && exitRead.value?.launchId === launchId
  );

  const ownerRead = await readJson(path.join(attemptDir, 'owner.json'));
  if (!ownerRead.present) {
    if (validExit) {
      return { launchId, attemptDir, signalDir, attempt, status: 'dead', reason: 'launch failed before ownership' };
    }
    return {
      launchId,
      attemptDir,
      signalDir,
      attempt,
      status: 'uncertain',
      reason: 'owner identity has not been recorded',
    };
  }
  if (!ownerValid(ownerRead.value, launchId)) {
    return {
      launchId,
      attemptDir,
      signalDir,
      attempt,
      status: 'uncertain',
      reason: 'owner identity is unreadable or mismatched',
    };
  }

  const owner = ownerRead.value;
  const observed = await inspect(owner.pid);
  if (observed.state === 'dead') {
    return {
      launchId,
      attemptDir,
      signalDir,
      attempt,
      owner,
      status: 'dead',
      reason: validExit ? 'launcher recorded exit and its process is dead' : observed.reason,
    };
  }
  if (observed.state !== 'live' || !observed.identity) {
    return {
      launchId,
      attemptDir,
      signalDir,
      attempt,
      owner,
      status: 'uncertain',
      reason: observed.reason || 'process identity could not be verified',
    };
  }
  if (observed.identity !== owner.processStart) {
    return {
      launchId,
      attemptDir,
      signalDir,
      attempt,
      owner,
      observed,
      status: 'dead',
      reason: `PID ${owner.pid} was reused by another process`,
    };
  }
  return { launchId, attemptDir, signalDir, attempt, owner, observed, status: 'live' };
}

export async function scanAttempts(sessionPanDir, expected, options = {}) {
  const runsDir = path.join(sessionPanDir, 'runs');
  const manifestPath = path.join(sessionPanDir, ATTEMPT_MANIFEST);
  const manifestRead = await readJson(manifestPath);
  if (!manifestRead.present || !manifestValid(manifestRead.value, expected)) {
    const reason = !manifestRead.present
      ? 'attempt manifest is missing'
      : 'attempt manifest is unreadable or mismatched';
    const uncertain = [{
      launchId: null,
      attemptDir: runsDir,
      signalDir: runsDir,
      status: 'uncertain',
      reason,
    }];
    return {
      runsDir,
      currentLaunchId: null,
      attempts: uncertain,
      live: [],
      dead: [],
      uncertain,
    };
  }
  const manifest = manifestRead.value;
  const recorded = new Map(manifest.attempts.map((entry) => [entry.launchId, entry]));

  let entries;
  try {
    const runsStat = await lstat(runsDir);
    if (!runsStat.isDirectory() || runsStat.isSymbolicLink()) {
      throw new Error('runs path is not a real directory');
    }
    entries = await readdir(runsDir);
  } catch (error) {
    return {
      runsDir,
      currentLaunchId: manifest.currentLaunchId,
      attempts: [{
        launchId: null,
        attemptDir: runsDir,
        signalDir: runsDir,
        status: 'uncertain',
        reason: `runs directory is unreadable: ${error.message}`,
      }],
      live: [],
      dead: [],
      uncertain: [{
        launchId: null,
        attemptDir: runsDir,
        signalDir: runsDir,
        status: 'uncertain',
        reason: `runs directory is unreadable: ${error.message}`,
      }],
    };
  }

  const attempts = [];
  const actual = new Set();
  for (const entry of entries.sort()) {
    if (!isLaunchId(entry)) {
      attempts.push({
        launchId: null,
        attemptDir: path.join(runsDir, entry),
        signalDir: path.join(runsDir, entry),
        status: 'uncertain',
        reason: `unexpected entry in attempt runs directory: ${entry}`,
      });
      continue;
    }
    actual.add(entry);
    if (!recorded.has(entry)) {
      attempts.push({
        launchId: entry,
        attemptDir: path.join(runsDir, entry),
        signalDir: path.join(runsDir, entry),
        status: 'uncertain',
        reason: 'attempt directory is not recorded in the durable manifest',
      });
      continue;
    }
    const attempt = await inspectAttempt(path.join(runsDir, entry), expected, options);
    if (attempt) attempts.push(attempt);
  }
  for (const launchId of recorded.keys()) {
    if (actual.has(launchId)) continue;
    attempts.push({
      launchId,
      attemptDir: path.join(runsDir, launchId),
      signalDir: path.join(runsDir, launchId),
      status: 'uncertain',
      reason: 'attempt recorded in the durable manifest is missing from runs',
    });
  }
  return {
    runsDir,
    currentLaunchId: manifest.currentLaunchId,
    attempts,
    live: attempts.filter((attempt) => attempt.status === 'live'),
    dead: attempts.filter((attempt) => attempt.status === 'dead'),
    uncertain: attempts.filter((attempt) => attempt.status === 'uncertain'),
  };
}

function deterministicLaunchId(metadata, creationKey) {
  const hex = createHash('sha256')
    .update(`${metadata.sessionId}\0${metadata.itemId}\0${creationKey}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-` +
    `${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function nextLaunchCreationKey(manifest) {
  let highest = 0;
  for (const entry of manifest.attempts) {
    if (entry.kind !== 'launch') continue;
    const match = /^launch:(\d+)$/.exec(entry.creationKey || '');
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return `launch:${highest + 1}`;
}

async function recoverableLaunchEntry(sessionPanDir, manifest) {
  if (!manifest.currentLaunchId) return null;
  const entry = manifest.attempts.find(
    (candidate) =>
      candidate.launchId === manifest.currentLaunchId
      && candidate.kind === 'launch'
      && typeof candidate.creationKey === 'string',
  );
  if (!entry) return null;
  const attemptDir = path.join(sessionPanDir, 'runs', entry.launchId);
  const [owner, exit] = await Promise.all([
    readJson(path.join(attemptDir, 'owner.json')),
    readJson(path.join(attemptDir, 'exit.json')),
  ]);
  return !owner.present && !exit.present ? entry : null;
}

export async function createAttempt(
  sessionPanDir,
  metadata,
  {
    creationKey = null,
    creationKind = null,
    checkpoint = async () => {},
  } = {},
) {
  let manifest = await ensureAttemptManifest(sessionPanDir, metadata);
  const runsDir = path.join(sessionPanDir, 'runs');
  if (creationKey != null && (typeof creationKey !== 'string' || !creationKey)) {
    throw new Error('attempt creation key must be a non-empty string');
  }
  if (creationKind != null && creationKind !== 'launch') {
    throw new Error(`unsupported attempt creation kind: ${creationKind}`);
  }
  if (creationKey == null) {
    const recoverable = await recoverableLaunchEntry(sessionPanDir, manifest);
    if (recoverable) {
      creationKey = recoverable.creationKey;
      creationKind = 'launch';
    } else {
      creationKey = nextLaunchCreationKey(manifest);
      creationKind = 'launch';
    }
  }
  const launchId = deterministicLaunchId(metadata, creationKey);
  const existingById = manifest.attempts.find((entry) => entry.launchId === launchId);
  const existingByKey = manifest.attempts.find((entry) => entry.creationKey === creationKey);
  if (
    (existingById && existingById.creationKey !== creationKey)
    || (existingByKey && existingByKey.launchId !== launchId)
    || (existingById && (existingById.kind ?? null) !== creationKind)
  ) {
    throw new Error(`attempt creation key conflicts with durable manifest: ${creationKey}`);
  }
  let createdAt = existingById?.createdAt || new Date().toISOString();
  const attemptDir = path.join(runsDir, launchId);

  if (!existingById) {
    await checkpoint('before-manifest');
    await atomicWriteJson(path.join(sessionPanDir, ATTEMPT_MANIFEST), {
      ...manifest,
      attempts: [
        ...manifest.attempts,
        {
          launchId,
          createdAt,
          creationKey,
          ...(creationKind ? { kind: creationKind } : {}),
        },
      ],
      currentLaunchId: launchId,
    });
    manifest = await ensureAttemptManifest(sessionPanDir, metadata);
    const committed = manifest.attempts.find((entry) => entry.launchId === launchId);
    if (
      !committed
      || committed.creationKey !== creationKey
      || (committed.kind ?? null) !== creationKind
    ) {
      throw new Error(`attempt creation lost a concurrent manifest update: ${creationKey}`);
    }
    createdAt = committed.createdAt;
  }
  await checkpoint('after-manifest');

  try {
    await ensurePrivateDir(attemptDir);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const attemptDirStat = await lstat(attemptDir);
  if (!attemptDirStat.isDirectory() || attemptDirStat.isSymbolicLink()) {
    throw new Error(`attempt path is not a real directory: ${attemptDir}`);
  }
  await checkpoint('after-attempt-directory');

  let attempt = {
    ...metadata,
    panRunnerAttempt: true,
    version: ATTEMPT_VERSION,
    launchId,
    createdAt,
    creationKey,
    ...(creationKind ? { kind: creationKind } : {}),
  };
  const attemptPath = path.join(attemptDir, 'attempt.json');
  const existingAttempt = await readJson(attemptPath);
  if (existingAttempt.present) {
    if (
      !attemptMetadataValid(existingAttempt.value, { ...metadata, launchId })
      || (existingAttempt.value.creationKey ?? null) !== creationKey
      || (existingAttempt.value.kind ?? null) !== creationKind
    ) {
      throw new Error(`existing attempt metadata is unreadable or mismatched: ${attemptPath}`);
    }
    // Concurrent ordinary creators use the same deterministic operation key
    // and launch id. Their informational timestamps may differ, but either
    // complete metadata record represents the same immutable attempt.
    attempt = existingAttempt.value;
  } else {
    await atomicWriteJson(attemptPath, attempt);
  }
  await checkpoint('after-attempt-metadata');
  return { launchId, attemptDir, attempt };
}

export async function recoverAttemptCreation(sessionPanDir, metadata, options = {}) {
  const manifest = await ensureAttemptManifest(sessionPanDir, metadata);
  const entry = await recoverableLaunchEntry(sessionPanDir, manifest);
  if (!entry) return null;
  return createAttempt(sessionPanDir, metadata, {
    ...options,
    creationKey: entry.creationKey,
    creationKind: 'launch',
  });
}

export async function acquireLaunchLock(
  sessionPanDir,
  {
    inspect = inspectProcess,
    pid = process.pid,
    checkpoint = async () => {},
  } = {},
) {
  const lockDirStat = await lstat(sessionPanDir);
  if (!lockDirStat.isDirectory() || lockDirStat.isSymbolicLink()) {
    throw new Error(`launch lock directory is not a real directory: ${sessionPanDir}`);
  }
  const self = await inspect(pid);
  if (self.state !== 'live' || !self.identity) {
    throw new Error(`cannot establish runner process identity for launch lock: ${self.reason || 'unknown'}`);
  }

  const lockPath = path.join(sessionPanDir, 'launch.lock');
  await ensurePrivateDir(lockPath, { recursive: true });
  const lockStat = await lstat(lockPath);
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
    throw new Error(`launch lock ${lockPath} is not a real directory`);
  }

  for (let retry = 0; retry < 12; retry += 1) {
    const token = randomUUID();
    const retryDelay = 2 + (Number.parseInt(token.slice(0, 4), 16) % 17);
    const claimPath = path.join(lockPath, `${token}.json`);
    const sequence = process.hrtime.bigint().toString().padStart(24, '0');
    const record = {
      panRunnerLaunchLock: true,
      version: ATTEMPT_VERSION,
      token,
      pid,
      processStart: self.identity,
      sequence,
      state: 'contending',
      createdAt: new Date().toISOString(),
    };
    const writeClaim = async (value) => {
      const stagingPath = path.join(
        sessionPanDir,
        `.launch-lock-${token}.${randomUUID()}.new`,
      );
      try {
        await privateWriteFile(stagingPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        await rename(stagingPath, claimPath);
      } finally {
        await rm(stagingPath, { force: true });
      }
    };
    await writeClaim(record);
    await checkpoint('claim-written', { claimPath, token });

    const abandon = async () => {
      await rm(claimPath, { force: true });
    };

    const scanClaims = async () => {
      for (let snapshotRetry = 0; snapshotRetry < 128; snapshotRetry += 1) {
        const records = [];
        let snapshotChanged = false;
        for (const entry of (await readdir(lockPath)).sort()) {
          if (!/^[0-9a-f-]{36}\.json$/i.test(entry)) {
            throw new Error(`launch lock ${lockPath} contains unexpected entry ${entry}`);
          }
          const candidatePath = path.join(lockPath, entry);
          let st;
          try {
            st = await lstat(candidatePath);
          } catch (error) {
            if (error?.code === 'ENOENT') {
              snapshotChanged = true;
              break;
            }
            throw error;
          }
          if (!st.isFile() || st.isSymbolicLink()) {
            throw new Error(`launch lock claim ${candidatePath} is not a real file`);
          }
          const read = await readJson(candidatePath);
          if (!read.present) {
            snapshotChanged = true;
            break;
          }
          const candidate = read.value;
          const expectedToken = entry.slice(0, -5);
          if (
            !candidate
            || candidate.panRunnerLaunchLock !== true
            || candidate.version !== ATTEMPT_VERSION
            || candidate.token !== expectedToken
            || !isLaunchId(candidate.token)
            || !Number.isInteger(candidate.pid)
            || candidate.pid <= 0
            || typeof candidate.processStart !== 'string'
            || !candidate.processStart
            || typeof candidate.sequence !== 'string'
            || !/^\d+$/.test(candidate.sequence)
            || !['contending', 'held'].includes(candidate.state)
          ) {
            throw new Error(`launch lock claim ${candidatePath} is unreadable or invalid`);
          }
          records.push(candidate);
        }
        if (!snapshotChanged) {
          const inspectOrdered = async (candidates, { firstLiveOnly = false } = {}) => {
            const inspected = [];
            for (const candidate of candidates) {
              const observed = await inspect(candidate.pid);
              if (observed.state === 'unknown') {
                throw new Error(
                  `launch lock ${lockPath} owner PID ${candidate.pid} cannot be verified; refusing concurrent launch`,
                );
              }
              const inspectedCandidate = {
                ...candidate,
                live: observed.state === 'live' && observed.identity === candidate.processStart,
              };
              inspected.push(inspectedCandidate);
              if (firstLiveOnly && inspectedCandidate.live) break;
            }
            return inspected;
          };
          const held = await inspectOrdered(
            records
              .filter((candidate) => candidate.state === 'held')
              .sort((a, b) => a.sequence.localeCompare(b.sequence) || a.token.localeCompare(b.token)),
          );
          if (held.some((candidate) => candidate.live)) return held;
          const contenders = await inspectOrdered(
            records
              .filter((candidate) => candidate.state === 'contending')
              .sort((a, b) => a.sequence.localeCompare(b.sequence) || a.token.localeCompare(b.token)),
            { firstLiveOnly: true },
          );
          return [...held, ...contenders];
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(`launch lock ${lockPath} did not reach a stable directory snapshot`);
    };

    try {
      const claims = await scanClaims();
      const held = claims.find((candidate) => candidate.live && candidate.state === 'held');
      if (held) {
        await abandon();
        throw new Error(
          `launch lock ${lockPath} is held by live runner PID ${held.pid}; refusing concurrent launch`,
        );
      }
      const contenders = claims
        .filter((candidate) => candidate.live && candidate.state === 'contending')
        .sort((a, b) => a.sequence.localeCompare(b.sequence) || a.token.localeCompare(b.token));
      if (contenders[0]?.token !== token) {
        await abandon();
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }

      await writeClaim({ ...record, state: 'held' });
      await checkpoint('claim-held', { claimPath, token });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const confirmed = await scanClaims();
      const otherHeld = confirmed.find(
        (candidate) => candidate.live && candidate.state === 'held' && candidate.token !== token,
      );
      if (otherHeld) {
        await abandon();
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }
      return { lockPath, claimPath, token };
    } catch (error) {
      await abandon();
      throw error;
    }
  }
  throw new Error(`could not acquire launch lock ${lockPath}`);
}

export async function releaseLaunchLock(lock) {
  if (!lock) return;
  const current = await readJson(lock.claimPath);
  if (current.value?.token !== lock.token || current.value?.state !== 'held') {
    throw new Error(`launch lock claim ${lock.claimPath} is no longer owned by this runner`);
  }
  await rm(lock.claimPath);
}
