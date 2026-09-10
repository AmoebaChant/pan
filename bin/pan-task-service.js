import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { demoTasks } from './pan-github-task-store.js';
import { derivePrimaryView, isTerminalStatus } from './pan-task-model.js';

const WEB_ROOT = new URL('../task-ui/', import.meta.url);
const MAX_REQUEST_BYTES = 256 * 1024;
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function responseHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...responseHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    const error = new Error('Content-Type must be application/json');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error('request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

async function serveAsset(pathname, response) {
  const asset = ASSETS.get(pathname);
  if (!asset) return false;
  const [filename, contentType] = asset;
  const body = await readFile(new URL(filename, WEB_ROOT));
  response.writeHead(200, {
    ...responseHeaders(contentType),
    'Content-Length': body.length,
    'Content-Security-Policy': [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  });
  response.end(body);
  return true;
}

function clone(value) {
  return structuredClone(value);
}

function assertHistoricalProvenanceMutation(task, input) {
  if (task.resourceSemantics !== 'historical-provenance') return;
  const operation = input.operation;
  const changes = operation === 'edit' ? (input.changes ?? {}) : {};
  const protectedChanges = [
    ['status', task.status],
    ['nextAction', task.nextAction],
    ['workerState', task.workerState],
    ['executionAuthorized', task.executionAuthorized],
    ['resourceSemantics', 'historical-provenance'],
  ];
  if (
    protectedChanges.some(
      ([name, current]) =>
        changes[name] !== undefined
        && changes[name] !== current,
    )
    || ['hold', 'handoff-ai', 'handoff-human', 'external-wait'].includes(operation)
  ) {
    throw Object.assign(
      new Error(
        `${operation} cannot reclassify or resume historical provenance; ` +
        'only checked operator migration or rollback may preserve this evidence',
      ),
      { statusCode: 409 },
    );
  }
}

export class DemoTaskStore {
  constructor() {
    this.state = demoTasks();
    for (const task of this.state.tasks) {
      task.projection = `demo:${task.id}:${task.revision}`;
    }
    this.details = new Map(this.state.tasks.map((task) => [
      task.id,
      {
        ...task,
        details: `${task.nextActionDetail}\n\nThis is invented public fixture data.`,
        comments: [
          {
            id: `comment-${task.id}`,
            author: 'pan-demo',
            createdAt: task.updatedAt,
            updatedAt: task.updatedAt,
            url: '#fixture-comment',
            body: `Pan: task transition ${task.revision}\n\nFixture history for ${task.title}.`,
          },
        ],
        artifacts: task.id === 'demo-3'
          ? [{ url: 'https://github.com/example/product/pull/42', sourceCommentUrl: '#fixture-comment' }]
          : [],
      },
    ]));
  }

  #rebuildViews() {
    const views = {
      today: [],
      'needs-me': [],
      'in-motion': [],
      recent: [],
      all: this.state.tasks.map((task) => task.id),
    };
    for (const task of this.state.tasks) {
      task.primaryView = derivePrimaryView(task, this.state.today);
      if (views[task.primaryView]) views[task.primaryView].push(task.id);
    }
    this.state.views = views;
  }

  async list() {
    this.#rebuildViews();
    return clone(this.state);
  }

  async detail(id) {
    const detail = this.details.get(id);
    if (!detail) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    const task = this.state.tasks.find((candidate) => candidate.id === id);
    return clone({ ...detail, ...task });
  }

  async capture(input) {
    const id = `demo-${this.state.tasks.length + 1}`;
    const task = {
      id,
      itemId: id,
      number: this.state.tasks.length + 1,
      repo: 'example/pan-domain',
      title: String(input.title || '').trim(),
      url: `#${id}`,
      status: 'ready-for-human',
      nextAction: 'clarify',
      nextActionDetail: input.currentActionDetail || 'Clarify and confirm the next action.',
      priority: input.priority || 'normal',
      nextActionDate: input.nextActionDate || '',
      deadline: input.deadline || '',
      playbook: '',
      workstream: input.workstream || '',
      executionAuthorized: 'no',
      dependencies: '',
      workerState: 'idle',
      needsHumanSince: '',
      claimedBy: '',
      leaseUntil: '',
      machine: '',
      sessionId: '',
      claimGeneration: '',
      resourceSemantics: '',
      revision: 1,
      recurring: !!input.recurrence,
      updatedAt: new Date().toISOString(),
      overdue: false,
      projection: `demo:${id}:1`,
    };
    this.state.tasks.push(task);
    this.details.set(id, {
      ...task,
      details: input.details || '',
      comments: [],
      artifacts: [],
    });
    return this.detail(id);
  }

  async mutate(input) {
    const task = this.state.tasks.find((candidate) => candidate.id === input.itemId);
    if (!task) throw Object.assign(new Error('task not found'), { statusCode: 404 });
    if (Number(input.revision) !== task.revision) {
      throw Object.assign(new Error('stale task revision'), { statusCode: 409 });
    }
    if (input.projection !== task.projection) {
      throw Object.assign(new Error('stale task projection'), { statusCode: 409 });
    }
    assertHistoricalProvenanceMutation(task, input);
    if (['starting', 'running', 'waiting-human', 'uncertain'].includes(task.workerState)) {
      throw Object.assign(new Error('fixture worker must be continued in its terminal'), { statusCode: 409 });
    }
    const operation = input.operation;
    if (operation === 'hold') {
      task.status = 'deliberate-hold';
      task.nextAction = 'hold';
    } else if (operation === 'handoff-ai') {
      task.status = 'ready-for-ai';
      task.nextAction = 'execute';
      task.executionAuthorized = 'yes';
    } else if (operation === 'handoff-human') {
      task.status = 'ready-for-human';
      task.nextAction = input.action;
      task.executionAuthorized = 'no';
    } else if (operation === 'external-wait') {
      task.status = 'external-waiting';
      task.nextAction = 'wait';
    } else if (operation === 'finish') {
      task.status = 'done';
      task.nextAction = 'none';
      task.nextActionDate = '';
      task.workerState = 'stopped';
    } else if (operation === 'reject') {
      task.status = 'rejected';
      task.nextAction = 'none';
      task.nextActionDate = '';
      task.workerState = 'stopped';
    } else if (operation === 'defer') {
      task.nextActionDate = input.date || '';
    } else if (operation === 'edit') {
      const changes = input.changes ?? {};
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'details') continue;
        if (key in task) task[key] = value;
      }
      if (changes.details !== undefined) this.details.get(task.id).details = changes.details;
    } else {
      throw new Error(`unsupported operation: ${operation}`);
    }
    task.nextActionDetail = input.detail
      || input.changes?.currentActionDetail
      || task.nextActionDetail;
    task.revision += 1;
    task.projection = `demo:${task.id}:${task.revision}`;
    task.updatedAt = new Date().toISOString();
    task.overdue = !isTerminalStatus(task.status)
      && !!task.nextActionDate
      && task.nextActionDate < this.state.today;
    const detail = this.details.get(task.id);
    detail.comments.push({
      id: `comment-${task.id}-${task.revision}`,
      author: 'pan-demo',
      createdAt: task.updatedAt,
      updatedAt: task.updatedAt,
      url: '#fixture-comment',
      body: `Pan: task transition ${task.revision}\n\nFixture operation: ${operation}.`,
    });
    return this.detail(task.id);
  }
}

export function createTaskHttpServer(store) {
  let authority = null;
  let origin = null;
  const server = http.createServer(async (request, response) => {
    try {
      if (!authority || request.headers.host !== authority) {
        json(response, 421, { error: 'request Host does not match the bound loopback service' });
        return;
      }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && await serveAsset(url.pathname, response)) return;
      if (request.method === 'GET' && url.pathname === '/api/health') {
        json(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/tasks') {
        json(response, 200, await store.list());
        return;
      }
      const detailMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && detailMatch) {
        json(response, 200, await store.detail(decodeURIComponent(detailMatch[1])));
        return;
      }
      const writeRequest = request.method === 'POST' || request.method === 'PATCH';
      if (writeRequest && request.headers.origin !== origin) {
        json(response, 403, { error: 'write Origin does not match the bound loopback service' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/tasks') {
        json(response, 201, await store.capture(await readJson(request)));
        return;
      }
      const actionMatch = /^\/api\/tasks\/([^/]+)\/actions$/.exec(url.pathname);
      if (request.method === 'POST' && actionMatch) {
        const input = await readJson(request);
        input.itemId = decodeURIComponent(actionMatch[1]);
        json(response, 200, await store.mutate(input));
        return;
      }
      json(response, 404, { error: 'not found' });
    } catch (error) {
      json(response, error.statusCode ?? 400, { error: error.message });
    }
  });

  return {
    server,
    async listen({ host = '127.0.0.1', port = 4320 } = {}) {
      if (!['127.0.0.1', '::1'].includes(host)) {
        throw new Error('task service may bind only to a loopback address');
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      const displayHost = address.address.includes(':') ? `[${address.address}]` : address.address;
      authority = `${displayHost}:${address.port}`;
      origin = `http://${authority}`;
      return { host: address.address, port: address.port, url: origin };
    },
    async close() {
      if (!server.listening) return;
      const done = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await done;
    },
  };
}
