# Legacy orchestration migration

Orchestration v2 snapshots `state.sqlite` into `statev2.sqlite` before opening writable persistence
on its first launch. Only the copy receives v2 migrations; the original remains available to v1.
Subsequent launches reuse the copy without refreshing it from v1. It creates v2 thread shell events first and imports
the complete user and assistant transcript lazily when a client reads or continues the thread. The
v1 projection tables remain the import source and provide a read-only recovery source if an import
needs investigation.

## Imported data

The shell import preserves the project and thread identifiers, title, provider and model selection,
runtime and interaction modes, branch, worktree path, creation and update times, archive and delete
times, settlement override and timestamps, snooze timestamps, pin timestamp and order, and linked
pull request. The metadata repair path fills snooze, pin order, `unsettledAt`, and linked pull request
fields for threads imported before those fields were covered.

Transcript import reads user and assistant rows from `projection_thread_messages`. It preserves
message identifiers, text, supported attachments, timestamps, role, and ordering. A message that was
still streaming becomes an interrupted turn item.

The importer does not translate provider session identity, native provider runs, checkpoints and
diffs, activities and tool calls, approvals, or proposed plans. V2 therefore must not present those
records as migrated history.

## First continuation

A migrated thread has no active provider thread. Its first continuation creates a fresh provider
session and sends a legacy handoff built only from user and assistant messages. The handoff selects
the newest transcript suffix within a 32,000-character budget, including section labels and the
import notice. This budget is separate from portable provider handoffs.

## Client and server cutover

Clients and servers must agree on the current value of `ORCHESTRATION_PROTOCOL_VERSION`
(1001 in GOAT). The client runtime appends that value as `orchestrationProtocol` to the socket URL,
and the `/ws` route rejects a missing or mismatched version with HTTP 426
(`orchestration_protocol_incompatible`) before any RPC or auth work runs. The client checks the
environment descriptor the same way: a missing version means the host predates protocol version
reporting, and a different version means both sides need updating. Either direction
blocks the connection as `unsupported` with a message naming the machine to update rather than
running half-upgraded. See `packages/client-runtime/src/connection/compatibility.ts` and
`apps/server/src/ws.ts`.

## Divergent migration ids

`effect_sql_migrations` records `migration_id` and `name`, but the migrator compares ids only:
rows at or below the recorded maximum are skipped without checking names. A database that ran a
local or fork migration under an id this build later assigns to a different migration therefore
never receives this build's migration at that id. After repairing supported V2 preview ledgers,
[`runMigrations`](../../apps/server/src/persistence/Migrations.ts) rejects history that would skip a
requested migration at id 55 or later without its expected name. Earlier name clashes remain
warnings for compatibility with site-local migrations. There is no safe id range for a fork inside
this ledger: any id at or below a future upstream id masks it forever, so fork schema changes belong
in a separate migration table or outside the migrator entirely.

## Recovery

There is no supported whole-thread export API. Recovery uses an untouched copy of the environment's
`userdata` directory and opens that copy with SQLite's read-only mode. The user guide documents the
queries against `projection_threads` and `projection_thread_messages`. Never start a server against
the recovery copy because startup can run migrations and write new state.

## GOAT migration ids

GOAT's own migrations sit after upstream's in `migrationEntries` and are named in
`GOAT_MIGRATION_NAMES`. When an upstream sync takes ids GOAT already used, GOAT's entries move up
together and keep their names. A ledger written before the move records GOAT names under the old
ids, so before the migrator runs,
[`reconcileGoatMigrationIds`](../../apps/server/src/persistence/reconcileGoatMigrationIds.ts), in
one transaction, runs each upstream migration those rows shadowed and records it, then rewrites
the GOAT rows to their current ids. GOAT bodies never run again, and upstream's displaced
migrations run exactly once because their ledger rows commit with them. A ledger that recorded
only some GOAT migrations moves those rows and leaves the rest to the migrator at their new ids.
It runs before `assertV2MigrationsCanRun`, which would otherwise read the old GOAT ids as skipped
upstream migrations.

Going back to an older build is refused rather than repaired. The older build sees GOAT rows
above its own ids next to an upstream name it does not know; its reconcile stops with
`BadState`, startup reports the database as newer than the build, and nothing is written. Only
the newer build or a copy taken before the upgrade opens it. Each GOAT server migrates only its
own database, so a remote host keeps its old ledger until its runtime updates, and an older
runtime started later on that host is refused the same way. Cycle 261024 is an example: upstream
`068_ShellStopRequestIndex` moved GOAT 068-101 to 069-102, and nightly 256 and earlier refuse a
database a later build migrated. The cases are pinned in `reconcileGoatMigrationIds.test.ts`.
