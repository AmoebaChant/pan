import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBackendPlaybook } from '../bin/pan-backend-playbooks.js';

test('playbook concurrency is an optional positive integer', () => {
  const loaded = validateBackendPlaybook(
    'pan-dev.md',
    `---
name: pan-dev
description: Develop Pan.
concurrency: 2
---

# pan-dev
`,
  );
  assert.equal(loaded.concurrency, 2);

  const unlimited = validateBackendPlaybook(
    'general.md',
    `---
name: general
description: General work.
---

# general
`,
  );
  assert.equal(unlimited.concurrency, null);
});

for (const value of ['0', '-1', '1.5', 'many']) {
  test(`playbook concurrency rejects ${value}`, () => {
    assert.throws(
      () =>
        validateBackendPlaybook(
          'pan-dev.md',
          `---
name: pan-dev
description: Develop Pan.
concurrency: ${value}
---
`,
        ),
      /concurrency must be a positive integer/,
    );
  });
}
