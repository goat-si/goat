import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { codexImportChanges } from "../../../../../packages/client-runtime/src/memoryImportWorkflow.ts";
import * as Service from "../MemoryService.ts";
import {
  buildMemoryImportFixture,
  snapshotMemoryImportFiles,
} from "./MemoryImportFixtures.fixture.ts";
import { harness, issue, uuid, space } from "./ProviderMemoryImport.testkit.ts";
import { live, setupProjects, batchSnapshot } from "./ProviderMemoryImportSql.testkit.ts";
describe("Codex source updates with the SQLite import store", () => {
  it.effect(
    "tracks only applied Codex notes and compares a fresh source snapshot with the stored body",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setupProjects;
          const fixture = yield* buildMemoryImportFixture("codex-ad-hoc-v1");
          const snapshot = batchSnapshot({
            ...fixture.snapshot,
            slot: { ...fixture.snapshot.slot, rootSlot: "default" },
          });
          const h = harness(snapshot);
          const service = yield* Service.MemoryService;
          const runtime = h.make(service.importPorts);
          const baseline = () =>
            runtime.run({ action: "codexBaseline", memorySpaceId: space }, Effect.void);
          assert.deepEqual(yield* baseline(), {
            action: "codexBaseline",
            sourceId: null,
            items: [],
            next: null,
          });
          const discovered = yield* runtime.run(
            { action: "discover", format: "codex", memorySpaceId: space },
            Effect.void,
          );
          if (discovered.action !== "discover") return assert.fail("discover");
          const sourceId = discovered.sources[0]!.sourceId;
          assert.deepEqual(yield* baseline(), {
            action: "codexBaseline",
            sourceId: null,
            items: [],
            next: null,
          });
          const preview = () =>
            runtime.run({ action: "preview", sourceId, memorySpaceId: space }, Effect.void);
          const initial = yield* preview();
          if (initial.action !== "preview") return assert.fail("preview");
          const first = initial.items[0]!;
          const selector = {
            sourceItemKey: first.sourceItemKey,
            sourceFingerprint: first.sourceFingerprint!,
            scope: { kind: "user" as const },
          };
          yield* runtime.run(
            {
              action: "apply",
              memorySpaceId: space,
              sourceId,
              sessionId: initial.sessionId,
              operationId: M.MemoryOperationId.make(uuid(734)),
              items: [selector],
            },
            Effect.void,
          );
          const expected: M.MemoryImportProviderResult = {
            action: "codexBaseline",
            sourceId,
            items: [{ ...selector, locallyEdited: false }],
            next: null,
          };
          assert.deepEqual(yield* baseline(), expected);
          const change = (text: string) =>
            h.source(
              snapshotMemoryImportFiles(
                snapshot,
                snapshot.files.map((file, index) =>
                  index ? file : { ...file, text, byteCount: text.length },
                ),
              ),
            );
          change("new guidance");
          const changed = yield* preview();
          if (changed.action !== "preview") return assert.fail("changed preview");
          const compare = () =>
            runtime.run(
              {
                action: "compareCodex",
                memorySpaceId: space,
                sourceId,
                sessionId: changed.sessionId,
                sourceItemKey: first.sourceItemKey,
                sourceFingerprint: changed.items[0]!.sourceFingerprint!,
              },
              Effect.void,
            );
          const result = yield* compare();
          if (result.action !== "compareCodex") return assert.fail("compare");
          assert.include(result.sourceText, "new guidance");
          assert.include(result.savedText, "a guidance");
          change("another unreviewed change");
          issue(yield* compare().pipe(Effect.flip), "source_changed");
          assert.deepEqual(yield* baseline(), expected);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO memory_pending_forget_intents (space,memory_id,operation_id,requested_at_utc,attempts,submission_state)
            SELECT space,memory_id,${uuid(733)},'2026-01-01T00:00:00.000Z',0,'unsubmitted' FROM memory_items WHERE space=${space}`;
          assert.deepEqual(yield* baseline(), {
            action: "codexBaseline",
            sourceId,
            items: [],
            next: null,
          });
        }),
      ).pipe(Effect.provide(live)),
  );
  it.effect(
    "reports a title-only Codex handbook rename as new and missing while keeping the saved memory",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* setupProjects;
          const originalTitle = "Local development";
          const renamedTitle = "Development setup";
          const handbook = (title: string) => `# Task Group: ${title}
scope: developer setup

## Task 1: Install dependencies

Use pnpm install.
`;
          const fixture = yield* buildMemoryImportFixture("codex-handbook-v1", {
            files: { "MEMORY.md": handbook(originalTitle) },
          });
          const snapshot = {
            ...fixture.snapshot,
            slot: { ...fixture.snapshot.slot, rootSlot: "default" },
          };
          const h = harness(snapshot);
          const service = yield* Service.MemoryService;
          const runtime = h.make(service.importPorts);
          const discovered = yield* runtime.run(
            { action: "discover", format: "codex", memorySpaceId: space },
            Effect.void,
          );
          if (discovered.action !== "discover") return assert.fail("expected discovery");
          const sourceId = discovered.sources[0]!.sourceId;
          const preview = () =>
            runtime.run({ action: "preview", sourceId, memorySpaceId: space }, Effect.void);
          const original = yield* preview();
          if (original.action !== "preview") return assert.fail("expected original preview");
          const row = original.items[0]!;
          const originalKey = `MEMORY.md#task-group:${originalTitle}`;
          assert.equal(row.sourceItemKey, originalKey);
          const apply = (sessionId: string, item: M.MemoryImportPreviewItem, operation: number) =>
            runtime.run(
              {
                action: "apply",
                sourceId,
                memorySpaceId: space,
                sessionId,
                operationId: M.MemoryOperationId.make(uuid(operation)),
                items: [
                  {
                    sourceItemKey: item.sourceItemKey,
                    sourceFingerprint: item.sourceFingerprint!,
                    scope: { kind: "user" },
                  },
                ],
              },
              Effect.void,
            );
          const applied = yield* apply(original.sessionId, row, 750);
          if (applied.action !== "apply") return assert.fail("expected import receipt");
          const memoryId = applied.receipt.items[0]?.memoryId;
          if (!memoryId) return assert.fail("expected saved memory ID");
          const read = () => service.read({ memorySpaceId: space, memoryId }, Effect.void);
          const before = yield* read();
          if (before.status !== "active") return assert.fail("expected active memory");
          assert.include(before.payload.text, "Use pnpm install.");
          const baseline = () =>
            runtime.run({ action: "codexBaseline", memorySpaceId: space }, Effect.void);
          const saved = yield* baseline();
          if (saved.action !== "codexBaseline") return assert.fail("expected baseline");
          assert.deepEqual(codexImportChanges(original.items, saved.items), []);
          const text = handbook(renamedTitle);
          const file = snapshot.files[0]!;
          h.source(
            snapshotMemoryImportFiles(snapshot, [
              { ...file, text, byteCount: new TextEncoder().encode(text).length },
            ]),
          );
          const renamed = yield* preview();
          if (renamed.action !== "preview") return assert.fail("expected renamed preview");
          const changes = codexImportChanges(renamed.items, saved.items);
          assert.deepEqual(
            changes.map((item) => [item.sourceItemKey, item.change]),
            [
              [`MEMORY.md#task-group:${renamedTitle}`, "New"],
              [originalKey, "Missing from Codex"],
            ],
          );
          assert.isString(changes[0]!.sourceFingerprint);
          assert.isUndefined(changes[1]!.sourceFingerprint);
          assert.deepEqual(yield* read(), before);
          assert.deepEqual(yield* baseline(), saved);
          const selected = yield* apply(renamed.sessionId, changes[0]!, 751);
          if (selected.action !== "apply") return assert.fail("expected selected import receipt");
          assert.deepEqual(
            selected.receipt.items.map((item) => item.sourceItemKey),
            [changes[0]!.sourceItemKey],
          );
          assert.deepEqual(yield* read(), before);
          const updated = yield* baseline();
          if (updated.action !== "codexBaseline") return assert.fail("expected updated baseline");
          assert.deepEqual(
            codexImportChanges(renamed.items, updated.items).map((item) => [
              item.sourceItemKey,
              item.change,
            ]),
            [[originalKey, "Missing from Codex"]],
          );
        }),
      ).pipe(Effect.provide(live)),
  );
});
