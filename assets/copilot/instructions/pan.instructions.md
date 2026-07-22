---
applyTo: "**"
---

# PAN domain instructions

Operate in exactly one configured PAN domain. The domain's GitHub Issues and
configured Project are the durable source of truth: Issues hold task records
and the Project supplies lifecycle, fields, and canonical ordering. Do not
create a second queue or treat conversation history as durable state.

Use ordinary built-in file, search, git, shell, and GitHub capabilities for
normal work in the configured domain. Read-only product-context roots are
reference material only. They are never another work domain and never grant
authority to modify PAN or any product-context repository.

## Evidence and recommendations

Before a material recommendation or mutation, run `pan evidence portfolio
--schema-version 1 --config "$PAN_DOMAIN_CONFIG" --json` and use its fresh snapshot. Treat
incomplete evidence as incomplete; distinguish facts, interpretations,
assumptions, and uncertainties. Cite durable Issues, Project fields,
workstream revisions, runner observations, or other inspectable records for
material recommendations.

Classify the complete portfolio, including completed, blocked, leased,
in-progress, and in-review work. Preserve the configured Project's canonical
order and deliberate human precedence. If evidence cannot support a safe
decision, ask one focused question rather than inventing certainty.

Before selecting portfolio changes in a writing session, run deterministic
reconciliation for missing Issues and merged pull requests. Refresh evidence
after every confirmed reconciliation effect.

## Authority and mutations

Read, analyze, recommend, and prepare a dry run freely. A session may mutate
only while it holds current PAN leadership. Before every mutation, use the
appropriate documented helper so it can validate leadership, policy, domain,
lifecycle, lease, expected state, and idempotency.

Use `pan action validate` before `pan action apply` for model-selected Project
or Issue actions. Use `pan attention` for attention and Issue-backed task
operations, `pan reconcile` for deterministic maintenance, `pan config` for
configuration, and `pan workstream` for workstream publication. Preserve active
runner leases, protected lifecycle work, human blocks, and unrelated changes.

Every helper requires `--schema-version 1`, `--config <config>`, and `--json`.
Read its result envelope. Report `confirmed`, `rejected`, `incomplete`, or
`failed` exactly as returned; include confirmed effects, remaining steps, and
safe recovery where relevant. Do not claim success from a proposed command or
an unconfirmed external effect.

## Session behavior

At the start of a writing-capable turn, establish or verify leadership through
the documented helper. A read-only session may inspect and discuss the domain,
but must say that mutations and scheduled reviews are unavailable.

Only a writing session may establish one native Copilot periodic review using
the supported session scheduling mechanism. Scheduled reviews follow this same
evidence and authority policy, refresh evidence immediately before decisions,
and never overlap another turn. Do not create a PAN-owned scheduler or attempt
to restore reviews after the session exits.

When the writing-session startup prompt supplies scheduling instructions,
establish exactly the one native `/every` schedule it names. Apply its startup
policy exactly once: `immediate` runs one fresh review now, `after-interval`
waits for the first due turn, and `manual` has no startup review. A read-only
session must not create a schedule or run an autonomous review. For a cadence
larger than the native interval, the scheduled prompt reads the supplied
launch-local due metadata and does nothing until the configured due time. This
metadata is not a durable queue: do not catch up reviews from an earlier
session. Keep failed, rejected, or incomplete reviews visible, and follow the
configured bounded retry guidance without creating a second schedule.

Use the PAN skills for their bounded workflows:

- `pan-portfolio` for review, evidence, and reconciliation;
- `pan-workstream` for isolated direct workstream delivery;
- `pan-attention` for questions, answers, and task creation.
