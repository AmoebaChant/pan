# Task 3.5: Manual Relative Constraints

## Goal

Detect Project ordering changes not applied by PAN and preserve them as durable relative-precedence constraints while allowing explained insertion of genuinely new urgent work.

## Requirements addressed

REQ-ORD-4–8, REQ-REL-2

## Background

`GitHubStateFile` in `src/leader-lease.js` already provides expected-SHA state files on the `pan-state` branch. Task 3.4 adds validated canonical ordering. The safe default is conservative: when current Project order differs from PAN's last confirmed order, record adjacent pairs from the externally observed order as manual constraints. These records are operational audit, never an alternate queue.

## Files to modify/create

- `src/order-audit.js` — versioned GitHub-backed last-applied order/audit record.
- `src/order-policy.js` — derive, merge, validate, and explicitly replace relative constraints.
- `test/order-audit.test.js` — expected-version contention and attribution.
- `test/order-policy.test.js` — drag detection, constraint preservation, urgent insertion, cycles, removed/new items.
- `src/index.js` — exports.

## Implementation details

1. Store last confirmed PAN order, turn/idempotency IDs, observed time, and active relative constraints in a separate state file using `GitHubStateFile`.
2. On review start, compare current Project order with last confirmed PAN order. If different and not attributable to the same PAN action, derive adjacent `before -> after` constraints from the observed order.
3. Merge constraints deterministically, discard pairs referencing removed items with an audit note, and reject cycles.
4. Validate proposed orders by topological precedence. Allow insertion of new urgent items anywhere that does not reverse constrained pairs; require rationale identifying the insertion.
5. Provide an explicit operation for chat to replace selected constraints. Never infer removal merely because PAN proposes another order.
6. Update audit only after Task 3.4 confirms the Project order.

## Testing suggestions

- `node --test test/order-audit.test.js test/order-policy.test.js`
- Cover one-item drag, multiple drags, new urgent item, stale audit, cycle, and deleted item.
- `npm test`

## Gotchas

- The audit cannot override the current Project order.
- Do not label every unchanged adjacent pair as a user preference unless an external change was observed.
- Conservative constraints may preserve more order than necessary; explicit chat changes provide release.

## Verification checklist

- [ ] External drags create durable relative constraints.
- [ ] PAN cannot reverse constrained pairs silently.
- [ ] New urgent work can be inserted with explanation.
- [ ] Targeted tests and `npm test` pass.
