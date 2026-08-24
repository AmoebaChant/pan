// The Project field contract the runner requires, mirroring system/project-schema.md.

/** The Project fields the runner requires, with the options each single-select must offer. */
export const CANONICAL_FIELDS = [
  {
    name: 'Status',
    type: 'single-select',
    options: [
      'untriaged',
      'needs-detail',
      'ready',
      'in-progress',
      'paused',
      'in-review',
      'done',
      'rejected',
      'blocked',
    ],
  },
  { name: 'owner', type: 'single-select', options: ['unassigned', 'human', 'agent'] },
  { name: 'priority', type: 'single-select', options: ['urgent', 'high', 'normal', 'low'] },
  { name: 'next-action-date', type: 'date' },
  { name: 'playbook', type: 'text' },
  { name: 'workstream', type: 'text' },
  { name: 'needs-human-since', type: 'text' },
  { name: 'lease-until', type: 'text' },
  { name: 'claimed-by', type: 'text' },
  { name: 'machine', type: 'text' },
  { name: 'session-id', type: 'text' },
];

/** The number of fields in the canonical contract. */
export const CANONICAL_FIELD_COUNT = CANONICAL_FIELDS.length;

const TYPE_TO_DATATYPE = {
  'single-select': 'SINGLE_SELECT',
  text: 'TEXT',
  date: 'DATE',
};

/** The problems that keep a Project from satisfying Pan's schema contract. */
export function schemaProblems(fields) {
  const problems = [];
  for (const spec of CANONICAL_FIELDS) {
    const field = fields.get(spec.name);
    if (!field) {
      problems.push(`missing ${spec.type} field "${spec.name}"`);
      continue;
    }
    const wantType = TYPE_TO_DATATYPE[spec.type];
    if (field.dataType !== wantType) {
      problems.push(`field "${spec.name}" must be a ${spec.type} field (found ${field.dataType})`);
      continue;
    }
    if (spec.type === 'single-select') {
      if (!(field.options instanceof Map)) {
        problems.push(`field "${spec.name}" must be a single-select (found ${field.dataType})`);
        continue;
      }
      for (const option of spec.options) {
        if (!field.options.has(option)) {
          problems.push(`single-select field "${spec.name}" is missing option "${option}"`);
        }
      }
    }
  }
  return problems;
}
