import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
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
});
