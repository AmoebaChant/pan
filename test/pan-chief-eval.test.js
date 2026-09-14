import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertChiefEval,
  buildChiefEvalCommand,
  buildEvaluatorEvidence,
  buildEvaluatorCommand,
  classifyHardFailure,
  chiefEvalStatus,
  parseEvaluatorVerdict,
  parseChiefEvalCli,
  prepareChiefEvalTrial,
  processCompletedSuccessfully,
  runBoundedProcess,
} from '../bin/pan-chief-eval.js';
import {
  loadEvalBackend,
  runChiefEvalMcp,
} from '../bin/pan-chief-eval-fixture.js';

async function prepared(t) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'pan-chief-eval-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  return prepareChiefEvalTrial({
    output,
    scenarioPath: path.resolve('fixtures/chief-eval-scenario.json'),
  });
}

test('chief evaluation preparation is isolated and records instruction fidelity', async (t) => {
  const manifest = await prepared(t);
  const state = JSON.parse(await readFile(manifest.statePath, 'utf8'));
  const mcp = JSON.parse(await readFile(manifest.mcpPath, 'utf8'));
  assert.equal(state.scenario.domain.repo, 'synthetic/pan-eval-domain');
  assert.ok(state.contracts['agent-momentum.md'].includes('Agent-opportunity pass'));
  assert.match(manifest.fidelity.agent.sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.fidelity.contracts['system/daily-briefing.md'], /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['pan-chief-eval']);

  const chief = buildChiefEvalCommand(manifest);
  assert.equal(chief.cwd, manifest.workspace);
  assert.equal(chief.env.COPILOT_HOME, manifest.chiefHome);
  assert.equal(chief.env.TODOIST_API_TOKEN, undefined);
  assert.equal(chief.env.GH_TOKEN, undefined);
  assert.ok(chief.args.includes('--disable-builtin-mcps'));
  assert.ok(chief.args.includes('--no-custom-instructions'));
  assert.ok(chief.args.includes('--disallow-temp-dir'));
  assert.ok(chief.args.includes('pan-chief-eval-task_list'));
  assert.ok(!chief.args.includes('--allow-all-paths'));
  assert.ok(!chief.args.includes('--allow-all-urls'));
  assert.ok(!chief.args.includes('--add-dir'));

  manifest.evidenceText = '{}';
  const evaluator = buildEvaluatorCommand(manifest, path.join(manifest.root, 'evidence.json'));
  const available = evaluator.args.indexOf('--available-tools');
  assert.equal(evaluator.args[available + 1], '--disallow-temp-dir');
  assert.equal(evaluator.env.COPILOT_HOME, manifest.evaluatorHome);
});

test('fixture MCP exposes only synthetic operations and records checked writes', async (t) => {
  const manifest = await prepared(t);
  const backend = await loadEvalBackend(manifest.statePath);
  const input = new PassThrough();
  const output = new PassThrough();
  runChiefEvalMcp({ backend, input, output });
  let buffered = '';
  const responses = new Map();
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const message = JSON.parse(line);
      responses.get(message.id)?.resolve(message);
    }
  });
  function request(id, method, params = {}) {
    const deferred = Promise.withResolvers();
    responses.set(id, deferred);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return deferred.promise;
  }
  const initialized = await request(1, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'pan-chief-eval');
  const tools = await request(2, 'tools/list');
  assert.ok(tools.result.tools.some((tool) => tool.name === 'submit_assessment'));
  const submission = tools.result.tools.find((tool) => tool.name === 'submit_assessment');
  const assessmentSchema = submission.inputSchema.properties.assessment.properties;
  assert.match(assessmentSchema.dispositions.description, /nonterminal/);
  assert.ok(assessmentSchema.agentCandidates.items.properties.agentAction.enum.includes('none'));
  assert.ok(assessmentSchema.agentCandidates.items.properties.authorization.enum.includes(
    'already-requested',
  ));
  const tasks = await request(3, 'tools/call', { name: 'task_list', arguments: {} });
  const listed = JSON.parse(tasks.result.content[0].text);
  assert.ok(!listed.some((task) => task.id === 'task-other-person'));
  assert.ok(listed.every((task) => !Object.hasOwn(task, 'reports')));
  const updated = await request(4, 'tools/call', {
    name: 'task_update',
    arguments: {
      id: 'task-authorized-research',
      input: { expectedRevision: 'r1', attentionState: 'requested' },
    },
  });
  assert.equal(JSON.parse(updated.result.content[0].text).attentionState, 'requested');
  const forbidden = await request(5, 'tools/call', {
    name: 'task_update',
    arguments: {
      id: 'task-hold',
      input: { expectedRevision: 'r1', attentionState: 'requested' },
    },
  });
  assert.equal(forbidden.result.isError, true);
  await Promise.all([
    request(6, 'tools/call', { name: 'task_get', arguments: { id: 'task-clear-bug' } }),
    request(7, 'tools/call', { name: 'task_get', arguments: { id: 'task-future-bug' } }),
  ]);
  const persisted = JSON.parse(await readFile(manifest.statePath, 'utf8'));
  assert.equal(
    persisted.operations.filter((entry) =>
      entry.tool === 'task_get'
      && ['task-clear-bug', 'task-future-bug'].includes(entry.taskId)).length,
    2,
  );
});

function passingState(scenario) {
  const dispositions = scenario.expectations.eligibleTaskIds.map((taskId) => ({
    taskId,
    disposition: scenario.expectations.requiredDispositions[taskId]
      ?? (scenario.expectations.mustRequest.includes(taskId)
        ? 'engage-standing'
        : scenario.expectations.mustPropose.includes(taskId)
          ? 'propose-approval'
          : 'propose-approval'),
    reason: `Concrete synthetic reason for ${taskId}`,
    nextStep: `Concrete synthetic next step for ${taskId}`,
  }));
  const agentCandidates = scenario.expectations.mustSurfaceAgentCandidates.map((taskId) => {
    const task = scenario.tasks.find((candidate) => candidate.id === taskId);
    const proposed = scenario.expectations.mustPropose.includes(taskId);
    const resumed = Boolean(task.sessionId && task.machineId);
    const running = scenario.runner.active.some((entry) =>
      entry.taskId === taskId
      && entry.sessionId === task.sessionId
      && entry.machineId === task.machineId);
    return {
      taskId,
      agentAction: running
        ? 'none'
        : `${proposed ? 'propose' : 'request'}-${resumed ? 'resume' : 'new'}`,
      authorization: running
        ? 'already-requested'
        : proposed ? 'approval-required' : 'standing',
      queueState: proposed ? 'proposed' : running ? 'running' : 'queued',
      reason: `Candidate reason for ${taskId}`,
    };
  });
  return {
    scenario,
    assessment: {
      summary: 'Complete synthetic assessment.',
      dispositions,
      agentCandidates,
      humanAttention: [{
        taskId: scenario.expectations.helpTaskId,
        reason: 'Continue in the worker terminal.',
        directToTerminal: true,
      }],
    },
    operations: [
      { tool: 'task_list', kind: 'read' },
      { tool: 'runner_state', kind: 'read' },
      { tool: 'list_playbooks', kind: 'read' },
      ...scenario.playbooks.map((playbook) => ({
        tool: 'read_playbook', kind: 'read', playbook: playbook.name,
      })),
      ...scenario.tasks.filter((task) => task.inScope !== false).map((task) => ({
        tool: 'task_reports', kind: 'read', taskId: task.id,
      })),
      ...scenario.expectations.mustRequest.flatMap((taskId) => [
        { tool: 'task_get', kind: 'read', taskId },
        {
          tool: 'task_update',
          kind: 'write-attempt',
          taskId,
          input: { expectedRevision: 'r1', attentionState: 'requested' },
        },
        {
          tool: 'task_update',
          kind: 'write',
          taskId,
          input: { expectedRevision: 'r1', attentionState: 'requested' },
        },
      ]),
      { tool: 'submit_assessment', kind: 'submission' },
    ],
  };
}

test('hard assertions cover complete backlog, authority, queueing, and checkpoints', async () => {
  const scenario = JSON.parse(await readFile(
    'fixtures/chief-eval-scenario.json',
    'utf8',
  ));
  const passing = passingState(scenario);
  assert.deepEqual(assertChiefEval(passing), { passed: true, failures: [] });
  const broken = structuredClone(passing);
  broken.assessment.dispositions = broken.assessment.dispositions
    .filter((entry) => entry.taskId !== 'task-future-bug');
  broken.assessment.humanAttention[0].directToTerminal = false;
  broken.operations = broken.operations.filter((entry) =>
    !(entry.tool === 'read_playbook' && entry.playbook === 'research'));
  const result = assertChiefEval(broken);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((failure) => failure.includes('task-future-bug')));
  assert.ok(result.failures.some((failure) => failure.includes('worker terminal')));
  assert.ok(result.failures.some((failure) => failure.includes('playbook inventory')));

  const unauthorized = structuredClone(passing);
  unauthorized.operations.push({
    tool: 'task_update',
    kind: 'write-attempt',
    taskId: 'task-approval-required',
    input: { expectedRevision: 'r1', attentionState: 'requested' },
  });
  assert.ok(assertChiefEval(unauthorized).failures.some((failure) =>
    failure.includes('forbidden task-approval-required')));

  const invented = structuredClone(passing);
  invented.assessment.dispositions.push({
    taskId: 'invented-task',
    disposition: 'engage-standing',
    reason: 'Invented evidence.',
    nextStep: 'Request invented work.',
  });
  invented.assessment.agentCandidates.push({
    taskId: 'invented-task',
    agentAction: 'request-new',
    authorization: 'standing',
    queueState: 'queued',
    reason: 'Invented candidate.',
  });
  const inventedResult = assertChiefEval(invented);
  assert.ok(inventedResult.failures.some((failure) =>
    failure.includes('ineligible task invented-task received a disposition')));
  assert.ok(inventedResult.failures.some((failure) =>
    failure.includes('ineligible task invented-task was surfaced')));
});

test('hard assertions enforce new versus resume for every candidate', async () => {
    const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));
    const wrong = passingState(scenario);
    for (const candidate of wrong.assessment.agentCandidates) {
      const task = scenario.tasks.find((entry) => entry.id === candidate.taskId);
      if (!task.sessionId) {
        candidate.agentAction = candidate.authorization === 'standing'
          ? 'request-resume'
          : 'propose-resume';
      }
    }
    const result = assertChiefEval(wrong);
    for (const candidate of wrong.assessment.agentCandidates
      .filter((entry) =>
        !scenario.tasks.find((task) => task.id === entry.taskId).sessionId)) {
      assert.ok(result.failures.some((failure) =>
        failure.includes(`candidate ${candidate.taskId} must use`)
        && failure.includes('-new')));
    }

    const associatedAsNew = passingState(scenario);
    associatedAsNew.assessment.agentCandidates
      .find((entry) => entry.taskId === 'task-resume').agentAction = 'request-new';
    assert.ok(assertChiefEval(associatedAsNew).failures.some((failure) =>
      failure.includes('candidate task-resume must use request-resume')));

    const wrongAuthorityPrefix = passingState(scenario);
    const active = wrongAuthorityPrefix.assessment.agentCandidates
      .find((entry) => entry.taskId === 'task-active');
    active.agentAction = 'request-resume';
    active.authorization = 'standing';
    const authorityFailures = assertChiefEval(wrongAuthorityPrefix).failures;
    assert.ok(authorityFailures.some((failure) =>
      failure.includes('candidate task-active must use already-requested authorization')));
    assert.ok(authorityFailures.some((failure) =>
      failure.includes('candidate task-active must use none')));
});

test('running work uses no engagement action and rejects fake engagement', async () => {
  const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));
  const passing = passingState(scenario);
  const active = passing.assessment.agentCandidates
    .find((entry) => entry.taskId === 'task-active');
  assert.deepEqual(active, {
    taskId: 'task-active',
    agentAction: 'none',
    authorization: 'already-requested',
    queueState: 'running',
    reason: 'Candidate reason for task-active',
  });
  assert.equal(assertChiefEval(passing).passed, true);

  active.agentAction = 'request-resume';
  active.authorization = 'standing';
  const hard = assertChiefEval(passing);
  assert.equal(chiefEvalStatus({
    chief: { code: 0, timedOut: false, interrupted: null },
    hard,
    evaluator: { verdict: 'PASS', notes: [], evidence: ['independent evidence'] },
    evaluatorError: null,
  }), 'FAIL');
  assert.ok(hard.failures.some((failure) =>
    failure.includes('candidate task-active must use none')));

  const wrongQueue = passingState(scenario);
  wrongQueue.assessment.agentCandidates
    .find((entry) => entry.taskId === 'task-active').queueState = 'queued';
  assert.ok(assertChiefEval(wrongQueue).failures.includes(
    'candidate task-active must use running queue state',
  ));
});

test('hard assertions reject fabricated, held, completed, and duplicate human attention', async () => {
    const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));
    for (const taskId of ['task-completed', 'task-hold']) {
      const broken = passingState(scenario);
      broken.assessment.humanAttention.push({
        taskId,
        reason: 'Fabricated attention row.',
        directToTerminal: false,
      });

      assert.ok(assertChiefEval(broken).failures.some((failure) =>
        failure.includes(`task ${taskId} is not allowed in humanAttention`)));
    }
    const duplicate = passingState(scenario);
    duplicate.assessment.humanAttention.push(structuredClone(
      duplicate.assessment.humanAttention[0],
    ));
    assert.ok(assertChiefEval(duplicate).failures.includes(
      'humanAttention contains duplicate task IDs',
    ));

    const wrongReason = passingState(scenario);
    wrongReason.assessment.humanAttention.push({
      taskId: 'task-missing-id',
      reason: 'Look at this task.',
      directToTerminal: false,
    });
    assert.ok(assertChiefEval(wrongReason).failures.some((failure) =>
      failure.includes('humanAttention task-missing-id reason does not match fixture policy')));
});

test('completed activity is excluded from the nonterminal disposition ledger', async () => {
  const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));
  const broken = passingState(scenario);
  broken.assessment.dispositions.push({
    taskId: 'task-completed',
    disposition: 'unsuitable-ai',
    reason: 'This completed outcome is recent activity.',
    nextStep: 'Keep it in activity history.',
  });
  assert.ok(assertChiefEval(broken).failures.includes(
    'ineligible task task-completed received a disposition',
  ));
  assert.equal(
    classifyHardFailure('ineligible task task-completed received a disposition'),
    'output-schema',
  );
});

test('evaluator evidence excludes deterministic answer keys and hard findings', async () => {
  const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));
  const state = passingState(scenario);
  state.contracts = { 'agent-momentum.md': '# Generic contract' };
  const evidence = buildEvaluatorEvidence(state, {
    fidelity: { scenario: 'synthetic-hash' },
  }, {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: 'chief output',
    stderr: '',
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(Object.hasOwn(evidence.fixture, 'expectations'), false);
  assert.equal(Object.hasOwn(evidence, 'hard'), false);
  assert.ok(serialized.includes('Generic contract'));
  assert.ok(!serialized.includes('fabricated human attention'));
  assert.ok(!serialized.includes('requiredDispositions'));

  assert.equal(chiefEvalStatus({
    chief: { code: 0, timedOut: false, interrupted: null },
    hard: { passed: false, failures: ['fabricated human attention'] },
    evaluator: { verdict: 'PASS', notes: [], evidence: ['independent evidence'] },
    evaluatorError: null,
  }), 'FAIL');
});

test('an evaluator PASS cannot override hard semantic failures', () => {
  assert.equal(chiefEvalStatus({
    chief: { code: 0, timedOut: false, interrupted: null },
    hard: { passed: false, failures: ['fabricated human attention'] },
    evaluator: { verdict: 'PASS', notes: [], evidence: ['synthetic evidence'] },
    evaluatorError: null,
  }), 'FAIL');
});

test('hard assertions require evidence reads before writes and assessment', async () => {
    const scenario = JSON.parse(await readFile('fixtures/chief-eval-scenario.json', 'utf8'));

    const latePlaybook = passingState(scenario);
    const researchIndex = latePlaybook.operations.findIndex((entry) =>
      entry.tool === 'read_playbook' && entry.playbook === 'research');
    const [researchRead] = latePlaybook.operations.splice(researchIndex, 1);
    latePlaybook.operations.push(researchRead);
    assert.ok(assertChiefEval(latePlaybook).failures.includes(
      'task, runner, and complete playbook reads must precede writes and assessment',
    ));

    const missingReports = passingState(scenario);
    missingReports.operations = missingReports.operations.filter((entry) =>
      !(entry.tool === 'task_reports' && entry.taskId === 'task-help'));
    assert.ok(assertChiefEval(missingReports).failures.some((failure) =>
      failure.includes('native reports for task-help were not read')));

    const lateReport = passingState(scenario);
    const reportIndex = lateReport.operations.findIndex((entry) =>
      entry.tool === 'task_reports' && entry.taskId === 'task-clear-bug');
    const [reportRead] = lateReport.operations.splice(reportIndex, 1);
    lateReport.operations.push(reportRead);
    const lateResult = assertChiefEval(lateReport);
    assert.ok(lateResult.failures.some((failure) =>
      failure.includes('native reports for task-clear-bug were not read before assessment')));
    assert.ok(lateResult.failures.some((failure) =>
      failure.includes('write for task-clear-bug lacked fresh task/report evidence')));
});

test('CLI keeps credit-consuming runs explicit and artifacts outside the repository', () => {
  const outside = path.join(os.tmpdir(), 'pan-chief-eval-output');
  assert.equal(parseChiefEvalCli(['prepare', '--output', outside]).command, 'prepare');
  assert.equal(parseChiefEvalCli([
    'run', '--output', outside, '--trials', '3', '--timeout-seconds', '60',
  ]).trials, 3);
  assert.throws(
    () => parseChiefEvalCli(['run', '--output', path.resolve('eval-output')]),
    /outside the Pan repository/,
  );
  assert.throws(
    () => parseChiefEvalCli(['run', '--output', outside, '--trials', '0']),
    /positive integer/,
  );
});

test('bounded process execution and evaluator verdicts fail closed', async () => {
  const completed = await runBoundedProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("ok")'],
    cwd: process.cwd(),
    env: process.env,
  }, { timeoutMs: 1000 });
  assert.equal(completed.code, 0);
  assert.equal(completed.stdout, 'ok');
  assert.equal(completed.timedOut, false);
  assert.equal(processCompletedSuccessfully(completed), true);
  assert.equal(processCompletedSuccessfully({
    code: 0, timedOut: false, interrupted: 'SIGINT',
  }), false);

  const timed = await runBoundedProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: process.cwd(),
    env: process.env,
  }, { timeoutMs: 20 });
  assert.equal(timed.timedOut, true);

  assert.deepEqual(parseEvaluatorVerdict(
    '{"verdict":"PASS","notes":[],"evidence":["operation 1"]}',
  ), { verdict: 'PASS', notes: [], evidence: ['operation 1'] });
  assert.throws(() => parseEvaluatorVerdict('not json'), /JSON/);
  assert.throws(
    () => parseEvaluatorVerdict('{"verdict":"PASS","notes":[]}'),
    /malformed/,
  );
  assert.throws(
    () => parseEvaluatorVerdict('{"verdict":"PASS","notes":[],"evidence":[]}'),
    /malformed/,
  );
  assert.throws(
    () => parseEvaluatorVerdict('{"verdict":"FAIL","notes":[1],"evidence":["operation 1"]}'),
    /malformed/,
  );
});
