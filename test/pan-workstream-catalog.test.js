import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadCatalogWorkstream,
  loadWorkstreamCatalog,
  parseWorkstreamDigest,
  parseWorkstreamStoreRegistry,
  resolveCatalogWorkstream,
} from '../bin/pan-workstreams.js';

const domainDigest = [
  '# Workstreams',
  '',
  '<!-- pan-workstream-catalog:v1 -->',
  '',
  '| Path | Name | Description |',
  '| --- | --- | --- |',
  '| [product](product/README.md) | Product | Product direction. |',
  '| [product/launch](product/launch/README.md) | Launch | Launch readiness. |',
  '',
].join('\n');

test('parses the registry and constrained root and nested digest entries', () => {
  assert.deepEqual(
    parseWorkstreamStoreRegistry(JSON.stringify({
      version: 1,
      defaultStore: 'shared',
      stores: [{ id: 'shared', repository: 'example/shared' }],
    })),
    {
      version: 1,
      defaultStore: 'shared',
      stores: [{ id: 'shared', repository: 'example/shared' }],
    },
  );
  assert.deepEqual(parseWorkstreamDigest(domainDigest), [
    {
      path: 'product',
      name: 'Product',
      description: 'Product direction.',
      documentPath: 'workstreams/product/README.md',
    },
    {
      path: 'product/launch',
      name: 'Launch',
      description: 'Launch readiness.',
      documentPath: 'workstreams/product/launch/README.md',
    },
  ]);
});

test('rejects malformed registries and digests', () => {
  assert.throws(
    () => parseWorkstreamStoreRegistry(JSON.stringify({
      version: 1,
      defaultStore: 'missing',
      stores: [],
    })),
    /defaultStore is unknown/,
  );
  assert.throws(
    () => parseWorkstreamDigest(domainDigest.replace(
      'product/README.md',
      'other/README.md',
    )),
    /link must target product\/README\.md/,
  );
});

test('loads all stores with provenance and resolves the selected document', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-workstreams-'));
  try {
    await mkdir(path.join(root, 'workstreams', 'product', 'launch'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'workstream-stores.json'),
      `${JSON.stringify({
        version: 1,
        defaultStore: 'shared',
        stores: [{ id: 'shared', repository: 'EXAMPLE/shared' }],
      }, null, 2)}\n`,
    );
    await writeFile(path.join(root, 'workstreams', 'README.md'), domainDigest);
    await writeFile(
      path.join(root, 'workstreams', 'product', 'README.md'),
      '# Product details\n',
    );
    const sharedDigest = [
      '# Workstreams',
      '',
      '<!-- pan-workstream-catalog:v1 -->',
      '',
      '| Path | Name | Description |',
      '| --- | --- | --- |',
      '| [engineering](engineering/README.md) | Engineering | Shared engineering knowledge. |',
      '',
    ].join('\n');
    const ghJson = async (args) => {
      const endpoint = args[2];
      if (endpoint === 'repos/EXAMPLE/shared') {
        return { full_name: 'example/shared' };
      }
      const requestedPath = endpoint.split('/contents/')[1];
      const text = requestedPath === 'workstreams/README.md'
        ? sharedDigest
        : '# Engineering details\n';
      return {
        type: 'file',
        sha: requestedPath === 'workstreams/README.md' ? 'shared-catalog' : 'shared-doc',
        content: Buffer.from(text).toString('base64'),
      };
    };
    const config = {
      domainPath: root,
      domainRepo: 'example/domain',
      domainRevision: 'domain-revision',
    };
    const catalog = await loadWorkstreamCatalog(config, { ghJson });
    assert.equal(catalog.defaultStore, 'shared');
    assert.deepEqual(
      catalog.workstreams.map(({ store, repository, path: workstreamPath }) => ({
        store,
        repository,
        path: workstreamPath,
      })),
      [
        {
          store: 'shared',
          repository: 'example/shared',
          path: 'engineering',
        },
        {
          store: 'domain',
          repository: 'example/domain',
          path: 'product',
        },
        {
          store: 'domain',
          repository: 'example/domain',
          path: 'product/launch',
        },
      ],
    );
    assert.equal(resolveCatalogWorkstream(catalog, 'engineering').store, 'shared');
    assert.equal(
      catalog.stores.find(({ id }) => id === 'domain').catalogRevision,
      'local-working-tree',
    );
    assert.deepEqual(
      await loadCatalogWorkstream(config, catalog, 'engineering', { ghJson }),
      {
        store: 'shared',
        repository: 'example/shared',
        path: 'engineering',
        name: 'Engineering',
        description: 'Shared engineering knowledge.',
        documentPath: 'workstreams/engineering/README.md',
        catalogPath: 'workstreams/README.md',
        catalogRevision: 'shared-catalog',
        text: '# Engineering details\n',
        revision: 'shared-doc',
      },
    );
    assert.deepEqual(
      await loadCatalogWorkstream(config, catalog, 'product', { ghJson }),
      {
        store: 'domain',
        repository: 'example/domain',
        path: 'product',
        name: 'Product',
        description: 'Product direction.',
        documentPath: 'workstreams/product/README.md',
        catalogPath: 'workstreams/README.md',
        catalogRevision: 'local-working-tree',
        text: '# Product details\n',
        revision: 'local-working-tree',
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects duplicate paths across stores without search-order fallback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-workstream-duplicates-'));
  try {
    await mkdir(path.join(root, 'workstreams'), { recursive: true });
    await writeFile(
      path.join(root, 'workstream-stores.json'),
      `${JSON.stringify({
        version: 1,
        defaultStore: 'domain',
        stores: [{ id: 'shared', repository: 'example/shared' }],
      })}\n`,
    );
    await writeFile(path.join(root, 'workstreams', 'README.md'), domainDigest);
    await assert.rejects(
      loadWorkstreamCatalog(
        { domainPath: root, domainRepo: 'example/domain' },
        {
          ghJson: async (args) => args[2] === 'repos/example/shared'
            ? { full_name: 'example/shared' }
            : {
              type: 'file',
              sha: 'shared-catalog',
              content: Buffer.from(domainDigest).toString('base64'),
            },
        },
      ),
      /duplicate workstream path "product".*domain.*shared/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses explicit GET arguments for pinned and unpinned remote Domain reads', async () => {
  const file = (text, sha) => ({
    type: 'file',
    sha,
    content: Buffer.from(text).toString('base64'),
  });
  const registry = `${JSON.stringify({
    version: 1,
    defaultStore: 'domain',
    stores: [],
  })}\n`;
  for (const [revision, suffix] of [['pinned-sha', ['-f', 'ref=pinned-sha']], ['', []]]) {
    const calls = [];
    await loadWorkstreamCatalog(
      { domainRepo: 'example/domain', domainRevision: revision },
      {
        ghJson: async (args) => {
          calls.push(args);
          return args[2].endsWith('/workstream-stores.json')
            ? file(registry, 'registry-sha')
            : file(domainDigest, 'catalog-sha');
        },
      },
    );
    assert.deepEqual(calls, [
      [
        '--method',
        'GET',
        'repos/example/domain/contents/workstream-stores.json',
        ...suffix,
      ],
      [
        '--method',
        'GET',
        'repos/example/domain/contents/workstreams/README.md',
        ...suffix,
      ],
    ]);
  }
});

test('labels a local-only Domain as working-tree provenance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pan-local-domain-'));
  try {
    await mkdir(path.join(root, 'workstreams', 'product'), { recursive: true });
    await writeFile(path.join(root, 'workstreams', 'README.md'), domainDigest);
    await writeFile(
      path.join(root, 'workstreams', 'product', 'README.md'),
      '# Product details\n',
    );
    const catalog = await loadWorkstreamCatalog({ domainPath: root });
    const repository = `local:${path.resolve(root)}`;
    assert.deepEqual(catalog.stores, [{
      id: 'domain',
      repository,
      catalogPath: 'workstreams/README.md',
      catalogRevision: 'local-working-tree',
    }]);
    assert.equal(catalog.workstreams[0].repository, repository);
    assert.equal(
      (await loadCatalogWorkstream(
        { domainPath: root },
        catalog,
        'product',
      )).revision,
      'local-working-tree',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('authoritative instructions require asking when store selection is unclear', async () => {
  const [contract, worker, chief] = await Promise.all([
    readFile(new URL('../system/workstreams.md', import.meta.url), 'utf8'),
    readFile(new URL('../system/worker-base-instructions.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/agents/pan-chief.agent.md', import.meta.url), 'utf8'),
  ]);
  for (const text of [contract, worker, chief]) {
    assert.match(text, /ask the user|ask rather than guessing|ask.*unclear/is);
  }
  assert.match(chief, /PAN_CHECKOUT/);
  assert.match(chief, /node .*pan-workstreams\.js/s);
});
