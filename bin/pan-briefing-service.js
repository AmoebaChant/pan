import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

const MAX_REQUEST_BYTES = 1024 * 1024;
const WEB_ROOT = new URL('../briefing-ui/', import.meta.url);

const WEB_ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requiredRevision(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('revision must be a positive integer');
  }
  return value;
}

function validateProposal(proposal) {
  if (!isObject(proposal)) throw new Error('proposal must be an object');
  requiredString(proposal.briefingId, 'briefingId');
  requiredRevision(proposal.revision);
  if (!Array.isArray(proposal.tasks)) throw new Error('tasks must be an array');
  const taskIds = new Set();
  for (const [index, task] of proposal.tasks.entries()) {
    if (!isObject(task)) throw new Error(`tasks[${index}] must be an object`);
    const taskId = requiredString(task.id, `tasks[${index}].id`);
    if (taskIds.has(taskId)) throw new Error(`duplicate task id: ${taskId}`);
    taskIds.add(taskId);
    requiredString(task.title, `tasks[${index}].title`);
    if (!['today', 'not-today'].includes(task.group)) {
      throw new Error(`tasks[${index}].group must be "today" or "not-today"`);
    }
    requiredString(task.recommendation, `tasks[${index}].recommendation`);
    requiredString(task.reason, `tasks[${index}].reason`);
  }
  return structuredClone(proposal);
}

function validateReview(review, proposal) {
  if (!isObject(review)) throw new Error('review must be an object');
  requiredString(review.briefingId, 'briefingId');
  requiredRevision(review.revision);
  if (!['revise', 'approve'].includes(review.action)) {
    throw new Error('action must be "revise" or "approve"');
  }
  if (review.briefingId !== proposal.briefingId || review.revision !== proposal.revision) {
    throw new Error('review does not match the current briefing revision');
  }
  if (!Array.isArray(review.tasks)) throw new Error('tasks must be an array');
  if (!isObject(review.proposal)) throw new Error('proposal snapshot must be an object');
  if (
    review.proposal.briefingId !== proposal.briefingId
    || review.proposal.revision !== proposal.revision
  ) {
    throw new Error('proposal snapshot does not match the current briefing revision');
  }
  const expectedTaskIds = new Set(proposal.tasks.map((task) => task.id));
  const reviewedTaskIds = new Set();
  for (const [index, task] of review.tasks.entries()) {
    if (!isObject(task)) throw new Error(`tasks[${index}] must be an object`);
    const taskId = requiredString(task.id, `tasks[${index}].id`);
    if (!expectedTaskIds.has(taskId)) throw new Error(`unknown reviewed task id: ${taskId}`);
    if (reviewedTaskIds.has(taskId)) throw new Error(`duplicate reviewed task id: ${taskId}`);
    reviewedTaskIds.add(taskId);
  }
  if (reviewedTaskIds.size !== expectedTaskIds.size) {
    throw new Error('review must account for every task in the proposal');
  }
  return structuredClone(review);
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(payload);
}

async function readJsonBody(request) {
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

export class BriefingBroker {
  #events = new EventEmitter();
  #proposal = null;
  #completion = null;
  #phase = 'empty';
  #queuedReview = null;
  #waiter = null;

  get snapshot() {
    return {
      phase: this.#phase,
      proposal: this.#proposal === null ? null : structuredClone(this.#proposal),
      completion: this.#completion === null ? null : structuredClone(this.#completion),
    };
  }

  publish(proposal) {
    const next = validateProposal(proposal);
    if (this.#waiter) {
      throw new Error('cannot publish a new proposal while a review wait is active');
    }
    if (this.#phase === 'awaiting-review') {
      throw new Error('the current proposal must be reviewed before publishing another');
    }
    if (
      this.#proposal
      && next.briefingId === this.#proposal.briefingId
      && next.revision <= this.#proposal.revision
    ) {
      throw new Error('a revised proposal must increase the revision number');
    }
    this.#proposal = next;
    this.#completion = null;
    this.#phase = 'awaiting-review';
    this.#queuedReview = null;
    this.#emit();
    return this.snapshot;
  }

  waitForReview(briefingId, revision) {
    requiredString(briefingId, 'briefingId');
    requiredRevision(revision);
    if (!this.#proposal) throw new Error('no briefing proposal has been published');
    if (
      this.#proposal.briefingId !== briefingId
      || this.#proposal.revision !== revision
    ) {
      throw new Error('requested briefing revision is not current');
    }
    if (this.#waiter) throw new Error('a review wait is already active');
    if (this.#queuedReview) {
      const review = this.#queuedReview;
      this.#queuedReview = null;
      return Promise.resolve(review);
    }
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  submitReview(review) {
    if (!this.#proposal) throw new Error('no briefing proposal has been published');
    const submitted = validateReview(review, this.#proposal);
    if (this.#phase === 'review-submitted') {
      throw new Error('a review has already been submitted for this revision');
    }
    this.#phase = 'review-submitted';
    if (this.#waiter) {
      const { resolve } = this.#waiter;
      this.#waiter = null;
      resolve(submitted);
    } else {
      this.#queuedReview = submitted;
    }
    this.#emit();
    return this.snapshot;
  }

  complete(result) {
    if (!isObject(result)) throw new Error('result must be an object');
    if (this.#waiter) {
      throw new Error('cannot complete a briefing while a review wait is active');
    }
    this.#completion = structuredClone(result);
    this.#phase = 'complete';
    this.#emit();
    return this.snapshot;
  }

  subscribe(listener) {
    this.#events.on('changed', listener);
    return () => this.#events.off('changed', listener);
  }

  close() {
    if (this.#waiter) {
      this.#waiter.reject(new Error('briefing service stopped'));
      this.#waiter = null;
    }
    this.#events.removeAllListeners();
  }

  #emit() {
    this.#events.emit('changed', this.snapshot);
  }
}

async function serveAsset(pathname, response) {
  const asset = WEB_ASSETS.get(pathname);
  if (!asset) return false;
  const [filename, contentType] = asset;
  const body = await readFile(new URL(filename, WEB_ROOT));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
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

export function createBriefingHttpServer(broker = new BriefingBroker()) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && await serveAsset(url.pathname, response)) return;

      if (request.method === 'GET' && url.pathname === '/api/health') {
        jsonResponse(response, 200, { ok: true });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/briefing') {
        jsonResponse(response, 200, broker.snapshot);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(`event: briefing\ndata: ${JSON.stringify(broker.snapshot)}\n\n`);
        const unsubscribe = broker.subscribe((snapshot) => {
          response.write(`event: briefing\ndata: ${JSON.stringify(snapshot)}\n\n`);
        });
        request.on('close', unsubscribe);
        return;
      }

      const reviewMatch = url.pathname.match(/^\/api\/briefings\/([^/]+)\/review$/);
      if (request.method === 'POST' && reviewMatch) {
        const review = await readJsonBody(request);
        const briefingId = decodeURIComponent(reviewMatch[1]);
        if (review.briefingId !== briefingId) {
          jsonResponse(response, 400, { error: 'briefing ID does not match the request URL' });
          return;
        }
        const snapshot = broker.submitReview(review);
        jsonResponse(response, 202, snapshot);
        return;
      }

      jsonResponse(response, 404, { error: 'not found' });
    } catch (error) {
      jsonResponse(response, error.statusCode ?? 400, { error: error.message });
    }
  });

  return {
    broker,
    server,
    async listen({ host = '127.0.0.1', port = 4318 } = {}) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return {
        host: address.address,
        port: address.port,
        url: `http://${address.address}:${address.port}`,
      };
    },
    async close() {
      broker.close();
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
