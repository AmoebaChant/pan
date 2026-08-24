import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_FIELDS,
  CANONICAL_FIELD_COUNT,
  schemaProblems,
} from '../bin/pan-project-schema.js';

// A resolved metadata map in the shape schemaProblems consumes.
function metaFields(overrides = {}) {
  const dataTypeFor = { 'single-select': 'SINGLE_SELECT', text: 'TEXT', date: 'DATE' };
  const fields = new Map();
  for (const spec of CANONICAL_FIELDS) {
    const options = spec.type === 'single-select'
      ? new Map(spec.options.map((name) => [name, `opt-${name}`]))
      : null;
    fields.set(spec.name, { dataType: dataTypeFor[spec.type], options });
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) fields.delete(name);
    else fields.set(name, value);
  }
  return fields;
}

test('a fully canonical Project reports no problems', () => {
  assert.deepEqual(schemaProblems(metaFields()), []);
  assert.equal(CANONICAL_FIELD_COUNT, CANONICAL_FIELDS.length);
});

test('a missing field is reported', () => {
  const problems = schemaProblems(metaFields({ 'session-id': undefined }));
  assert.deepEqual(problems, ['missing text field "session-id"']);
});

test('a wrong-typed field is reported without an option scan', () => {
  const problems = schemaProblems(
    metaFields({ playbook: { dataType: 'SINGLE_SELECT', options: new Map() } }),
  );
  assert.deepEqual(problems, ['field "playbook" must be a text field (found SINGLE_SELECT)']);
});

test('a canonical single-select missing an option is reported (option drift)', () => {
  const partial = new Map([
    ['unassigned', 'opt-unassigned'],
    ['human', 'opt-human'],
  ]);
  const problems = schemaProblems(metaFields({ owner: { dataType: 'SINGLE_SELECT', options: partial } }));
  assert.deepEqual(problems, ['single-select field "owner" is missing option "agent"']);
});

test('extra fields and extra options are tolerated', () => {
  const fields = metaFields();
  fields.set('custom-extra', { dataType: 'TEXT', options: null });
  fields.get('priority').options.set('someday', 'opt-someday');
  assert.deepEqual(schemaProblems(fields), []);
});

test('multiple problems are all collected in one pass', () => {
  const problems = schemaProblems(
    metaFields({
      owner: undefined,
      'next-action-date': { dataType: 'TEXT', options: null },
    }),
  );
  assert.deepEqual(problems.sort(), [
    'field "next-action-date" must be a date field (found TEXT)',
    'missing single-select field "owner"',
  ]);
});
