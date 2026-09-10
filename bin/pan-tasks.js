#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  GitHubTaskStore,
  loadTaskServiceBinding,
} from './pan-github-task-store.js';
import {
  createTaskHttpServer,
  DemoTaskStore,
} from './pan-task-service.js';

const HELP = `Pan everyday task UI

Usage:
  node bin/pan-tasks.js --demo [--port 4321]
  node bin/pan-tasks.js --config <absolute-path> --checkout <absolute-path> [--port 4320]

Live mode is read-only until the browser submits an explicit checked action.
It requires both the machine config and this Pan checkout; neither is
auto-discovered from global agent or skill configuration.
`;

export function parseTaskCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      demo: { type: 'boolean', default: false },
      config: { type: 'string' },
      checkout: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  if (values.help) return { help: true };
  const port = values.port == null
    ? (values.demo ? 4321 : 4320)
    : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer from 0 through 65535');
  }
  if (!['127.0.0.1', '::1'].includes(values.host)) {
    throw new Error('--host must be 127.0.0.1 or ::1');
  }
  if (values.demo) {
    if (values.config || values.checkout) {
      throw new Error('--demo cannot be combined with --config or --checkout');
    }
  } else if (!values.config || !values.checkout) {
    throw new Error('live mode requires both --config and --checkout');
  }
  return {
    help: false,
    demo: values.demo,
    config: values.config,
    checkout: values.checkout,
    host: values.host,
    port,
  };
}

export async function startTaskService(options) {
  const store = options.demo
    ? new DemoTaskStore()
    : await new GitHubTaskStore(
        await loadTaskServiceBinding(options.config, options.checkout),
      ).initialize();
  const service = createTaskHttpServer(store);
  const address = await service.listen({ host: options.host, port: options.port });
  return { service, address, store };
}

async function main() {
  const options = parseTaskCli(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { service, address } = await startTaskService(options);
  process.stderr.write(`Pan tasks${options.demo ? ' demo' : ''}: ${address.url}\n`);
  const shutdown = async () => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`pan-tasks: ${error.message}\n`);
    process.exitCode = 1;
  });
}
