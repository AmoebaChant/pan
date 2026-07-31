# Workstream Issue migration

`pan migrate-workstreams` is the one-time conversion from
`workstreams/**/README.md` to Workstream Issues. It reads the domain default
branch through GitHub APIs and never requires a checkout.

Always start with a dry-run:

```powershell
pan migrate-workstreams --config <machine-config> `
  --report .\workstream-migration.json `
  --dry-run
```

The report records every source path, planned or created Issue, parent
relationship, task field change, registered legacy task, skip, and error.
Supply a previous report with `--resume`; its durable path-to-Issue mapping
prevents duplicate Issues and completed relationships or task changes are
skipped.

After review, an explicit apply run is:

```powershell
pan migrate-workstreams --config <machine-config> `
  --report .\workstream-migration-applied.json `
  --resume .\workstream-migration.json `
  --apply
```

The migration:

1. creates exact-`Workstream` Issues with unchanged Markdown bodies;
2. creates GitHub parent/sub-issue relationships for directory nesting;
3. converts mapped Project `workstream` paths to Issue URLs and clears
   unreliable associations;
4. registers every legacy non-workstream Issue as a task, including closed
   Issues, without reopening them;
5. preserves existing Project and runner-owned fields and initializes newly
   registered closed history as `done`; and
6. verifies bodies, labels, hierarchy, and all non-empty task associations.

Markdown sources are retained unless verification is complete. With the
separate `--create-removal-pr` apply option, Pan creates a branch and pull
request that removes the verified files; it never deletes them directly from
the default branch.
