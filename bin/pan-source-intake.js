#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isCliEntry, loadTaskBackend, writeJson } from './pan-task-backend.js';
import { runGh } from './pan-github-task-backend.js';
import {
  applySourceIntake,
  discoverGitHubIssues,
  emptyReceiptLedger,
  planSourceIntake,
  resolveGitHubIntakeConfig,
  validateReceiptLedger,
} from './pan-source-intake-core.js';

const HELP = `Pan GitHub Issue source intake

Usage:
  pan-source-intake preview --config <machine-binding.json>
  pan-source-intake apply --config <machine-binding.json> --confirm-intake

Preview is read-only. Apply reserves each source in the Domain receipt ledger,
uses an idempotent backend create, then finalizes the receipt. Independent
failures are reported and produce exit code 2.
`;

const ISSUE_SNAPSHOT_QUERY = `
query PanSourceIntakeIssues($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(
      first: 100
      after: $after
      states: [OPEN, CLOSED]
      orderBy: { field: CREATED_AT, direction: ASC }
    ) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        number
        url
        title
        body
        state
        updatedAt
        assignees(first: 100) {
          nodes { login }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
}
`;

function contentsEndpoint(repo, filename) {
  return `repos/${repo}/contents/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

async function defaultGhJson(args, options = {}) {
  return runGh(args, options);
}

export class GitHubIntakeClient {
  constructor(domainRepo, ghJson = defaultGhJson) {
    this.domainRepo = domainRepo;
    this.ghJson = ghJson;
    this.login = null;
  }

  async currentUser() {
    if (!this.login) {
      const user = await this.ghJson(['api', 'user']);
      this.login = String(user.login || '');
    }
    return this.login;
  }

  async listIssueConnectionPage(repository, cursor) {
    const [owner, name] = repository.split('/');
    const result = await this.ghJson([
      'api',
      'graphql',
      '-f', `query=${ISSUE_SNAPSHOT_QUERY}`,
      '-f', `owner=${owner}`,
      '-f', `name=${name}`,
      ...(cursor ? ['-f', `after=${cursor}`] : []),
    ]);
    const connection = result?.data?.repository?.issues;
    if (!connection) throw new Error(`${repository} returned no Issue connection`);
    return {
      totalCount: connection.totalCount,
      pageInfo: connection.pageInfo,
      nodes: (connection.nodes ?? []).map((issue) => {
        if (issue.assignees?.pageInfo?.hasNextPage) {
          throw new Error(`${repository} Issue #${issue.number} assignees were truncated`);
        }
        return {
          number: issue.number,
          node_id: issue.id,
          html_url: issue.url,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          updated_at: issue.updatedAt,
          assignees: issue.assignees?.nodes ?? [],
        };
      }),
    };
  }

  async getIssue(repository, number) {
    return this.ghJson(['api', `repos/${repository}/issues/${number}`]);
  }

  async retireIssue(source, task) {
    const endpoint = `repos/${source.repository}/issues/${source.number}`;
    const self = (await this.currentUser()).toLowerCase();
    const assertEligible = (issue) => {
      if (issue.node_id !== source.nodeId || issue.html_url !== source.url
          || issue.state !== 'open' || issue.pull_request
          || !Array.isArray(issue.assignees)
          || (issue.assignees.length && !issue.assignees.some((a) => a.login.toLowerCase() === self))) {
        throw new Error('source Issue changed identity or eligibility before retirement');
      }
    };
    const live = await this.getIssue(source.repository, source.number);
    assertEligible(live);
    if (live.updated_at !== source.updatedAt) {
      throw new Error('source Issue changed after preview; rerun retirement');
    }
    const label = 'migrated-to-todoist';
    try {
      await this.ghJson(['api', `repos/${source.repository}/labels/${label}`]);
    } catch (error) {
      if (!/HTTP 404/.test(error.message)) throw error;
      await this.ghJson(['api', '--method', 'POST', `repos/${source.repository}/labels`,
        '--input', '-'], { input: JSON.stringify({
        name: label, color: '5319e7', description: 'Work tracking moved to Todoist; not a fixed or rejected outcome.',
      }) });
    }
    await this.ghJson(['api', '--method', 'POST', `${endpoint}/labels`, '--input', '-'], {
      input: JSON.stringify({ labels: [label] }),
    });
    const body = `<!-- pan-migration:todoist:${task.id} -->\n`
      + `Work tracking has moved to Todoist: https://app.todoist.com/app/task/${encodeURIComponent(task.id)}\n\n`
      + `Task: ${task.title}\n\n`
      + 'This Issue is closed as migrated, not fixed, shipped, or rejected. '
      + 'Follow the Todoist task for status and next actions. This Issue remains reference history.';
    const pages = await this.ghJson(['api', '--paginate', '--slurp', `${endpoint}/comments?per_page=100`]);
    if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
      throw new Error('invalid migration comment pagination');
    }
    if (!pages.flat().some((comment) => comment.user?.login?.toLowerCase() === self
        && comment.body === body)) {
      const created = await this.ghJson(['api', '--method', 'POST', `${endpoint}/comments`, '--input', '-'], {
        input: JSON.stringify({ body }),
      });
      if (created.body !== body || created.user?.login?.toLowerCase() !== self) {
        throw new Error('migration destination comment did not verify');
      }
    }
    const beforeClose = await this.getIssue(source.repository, source.number);
    assertEligible(beforeClose);
    if (!beforeClose.labels.some((value) => value.name === label)) {
      throw new Error('migration label is missing; refusing to close source');
    }
    await this.ghJson(['api', '--method', 'PATCH', endpoint, '--input', '-'], {
      input: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
    });
    const closed = await this.getIssue(source.repository, source.number);
    if (closed.node_id !== source.nodeId || closed.state !== 'closed'
        || closed.state_reason !== 'not_planned'
        || !closed.labels.some((value) => value.name === label)) {
      throw new Error('source retirement did not verify');
    }
  }

  async readFile(filename, { optional = false } = {}) {
    try {
      const result = await this.ghJson([
        'api',
        '-H', 'Accept: application/vnd.github+json',
        contentsEndpoint(this.domainRepo, filename),
      ]);
      if (result.type !== 'file' || result.encoding !== 'base64') {
        throw new Error(`${filename} is not a base64-encoded Domain file`);
      }
      return {
        text: Buffer.from(String(result.content).replace(/\s/g, ''), 'base64').toString('utf8'),
        revision: result.sha,
      };
    } catch (error) {
      if (optional && /(?:HTTP 404|Not Found)/i.test(error.message)) {
        return { text: null, revision: null };
      }
      throw error;
    }
  }

  async listWorkstreams() {
    const repository = await this.ghJson(['api', `repos/${this.domainRepo}`]);
    const defaultBranch = String(repository.default_branch || '').trim();
    if (!defaultBranch) throw new Error('Domain repository has no default branch');
    const tree = await this.ghJson([
      'api',
      `repos/${this.domainRepo}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    ]);
    if (tree.truncated) throw new Error('Domain workstream tree was truncated');
    const filenames = (tree.tree ?? [])
      .filter((entry) =>
        entry.type === 'blob'
        && /^workstreams\/.+\/README\.md$/.test(entry.path))
      .map((entry) => entry.path)
      .sort();
    return Promise.all(filenames.map(async (filename) => ({
      path: filename.slice('workstreams/'.length, -'/README.md'.length),
      content: (await this.readFile(filename)).text,
    })));
  }

  receiptStore(filename) {
    return {
      read: async () => {
        const value = await this.readFile(filename, { optional: true });
        return {
          ledger: value.text == null
            ? emptyReceiptLedger()
            : validateReceiptLedger(JSON.parse(value.text)),
          revision: value.revision,
        };
      },
      write: async (ledger, expectedRevision) => {
        const body = {
          message: 'Record Pan source intake receipt',
          content: Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`).toString('base64'),
          ...(expectedRevision ? { sha: expectedRevision } : {}),
        };
        await this.ghJson([
          'api',
          '--method', 'PUT',
          '-H', 'Accept: application/vnd.github+json',
          contentsEndpoint(this.domainRepo, filename),
          '--input', '-',
        ], { input: JSON.stringify(body) });
        const verified = await this.readFile(filename);
        const parsed = validateReceiptLedger(JSON.parse(verified.text));
        if (JSON.stringify(parsed) !== JSON.stringify(ledger)) {
          throw new Error('source intake receipt verification failed');
        }
        return { ledger: parsed, revision: verified.revision };
      },
    };
  }
}

export function parseSourceIntakeCli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') return { help: true };
  if (!['preview', 'apply'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string' },
      'confirm-intake': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return { help: true };
  if (!values.config || !path.isAbsolute(values.config)) {
    throw new Error('--config must be an absolute machine-binding path');
  }
  if (command === 'apply' && !values['confirm-intake']) {
    throw new Error('apply requires --confirm-intake');
  }
  return { help: false, command, config: values.config };
}

export async function runSourceIntake(options, dependencies = {}) {
  const read = dependencies.readFile || readFile;
  const binding = dependencies.binding
    || JSON.parse(await read(options.config, 'utf8'));
  const domainRepo = String(binding.domainRepo || '').trim();
  const backendConfigPath = String(binding.taskBackendConfig || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(domainRepo)) {
    throw new Error('machine binding domainRepo must be owner/repository');
  }
  if (!path.isAbsolute(backendConfigPath)) {
    throw new Error('machine binding taskBackendConfig must be an absolute path');
  }
  const github = dependencies.github || new GitHubIntakeClient(
    domainRepo,
    dependencies.ghJson || defaultGhJson,
  );
  const domainConfig = dependencies.domainConfig
    || JSON.parse((await github.readFile('task-backend.json')).text);
  const configured = domainConfig?.sourceIntake?.githubIssues;
  const workstreams = configured?.workstreamBacklogs === true
    ? (dependencies.workstreams || await github.listWorkstreams())
    : [];
  const intake = resolveGitHubIntakeConfig(domainConfig, workstreams);
  const localBackendConfig = JSON.parse(await read(backendConfigPath, 'utf8'));
  if (localBackendConfig.backend !== intake.backend) {
    throw new Error('Domain and local task backend configurations do not match');
  }
  const receiptStore = dependencies.receiptStore || github.receiptStore(intake.receiptPath);
  const receiptSnapshot = await receiptStore.read();
  const discovery = await discoverGitHubIssues(github, intake.sources);
  const plan = planSourceIntake(discovery, receiptSnapshot.ledger, intake.backend);
  plan.projectMappings = intake.projectMappings;
  plan.closeMigratedIssues = intake.closeMigratedIssues;
  if (options.command === 'preview') {
    return {
      exitCode: plan.actions.some((action) => action.action === 'conflict') ? 2 : 0,
      result: plan,
    };
  }
  const backend = dependencies.backend || await loadTaskBackend(
    backendConfigPath,
    { ...dependencies, backendConfig: localBackendConfig },
  );
  if (!dependencies.backend) await backend.initialize();
  const report = await applySourceIntake(plan, {
    backend,
    github,
    receiptStore,
    now: dependencies.now,
  });
  return { exitCode: report.partial ? 2 : 0, result: report };
}

async function main() {
  const options = parseSourceIntakeCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const outcome = await runSourceIntake(options);
  writeJson({ ok: outcome.exitCode === 0, result: outcome.result });
  process.exitCode = outcome.exitCode;
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    writeJson({
      ok: false,
      error: { code: error.code || 'error', message: error.message },
    }, process.stderr);
    process.exitCode = 1;
  });
}
