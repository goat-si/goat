import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { backdate, layer, machine, setup } from "./StorageReclaim.testkit.ts";

interface ThreadState {
  readonly activeRunId?: string;
  readonly status?: string;
}

// A No project thread working in <GOAT home>/scratch/<name>, idle unless told otherwise.
const scratchFixture = Effect.gen(function* () {
  const base = yield* setup;
  const { fs, path, config } = base;
  const sql = yield* SqlClient.SqlClient;
  const scratch = path.join(yield* fs.realPath(config.baseDir), "scratch");
  const folder = path.join(scratch, "2026-11-01-notes");
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.writeFileString(path.join(folder, "notes.md"), "draft\n");
  yield* backdate(folder);
  const bind = (id: string, title: string, state: ThreadState = {}) =>
    sql`
      INSERT OR REPLACE INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
         created_at, updated_at, payload_json)
      VALUES (${id}, 'scratch', ${title}, 'codex', 'full-access', 'default',
        '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z',
        ${JSON.stringify({ worktreePath: folder, branch: null, status: "completed", activeRunId: null, pendingRuntimeRequest: null, ...state })})
    `;
  yield* bind("thread-notes", "Notes");
  const listed = Effect.gen(function* () {
    const report = yield* base.reclaim.usage({ rescan: true });
    return { report, item: base.find(report.items, folder) };
  });
  return { ...base, folder, bind, listed };
});

const provide = Effect.provide(layer(process.env.TMPDIR ?? "/tmp"));

it.live("lists an idle No project folder as removable, never in the default selection", () =>
  Effect.gen(function* () {
    const { listed } = yield* scratchFixture;
    const { report, item } = yield* listed;
    expect(item).toMatchObject({
      kind: "orphan_folder",
      state: "removable",
      selected: false,
      label: "No project/2026-11-01-notes",
      reason:
        'Folder of the No project thread "Notes", idle since 2026-11-02. Removing it deletes its files for good; the thread\'s next turn starts in an empty folder.',
    });
    // goat storage --clean and goat_storage_clean without items take only the default selection.
    expect(report.items.filter((each) => each.selected).map((each) => each.id)).not.toContain(
      item?.id,
    );
  }).pipe(Effect.scoped, provide),
);

it.live("keeps a No project folder whose thread is working in it", () =>
  Effect.gen(function* () {
    const { bind, listed } = yield* scratchFixture;
    yield* bind("thread-notes", "Notes", { activeRunId: "run-1", status: "running" });
    const { item } = yield* listed;
    expect(item).toMatchObject({
      state: "protected",
      reason: 'The No project thread "Notes" is working in it',
    });
  }).pipe(Effect.scoped, provide),
);

it.live("deletes a chosen No project folder while its thread is still idle", () =>
  Effect.gen(function* () {
    const { fs, folder, reclaim, listed } = yield* scratchFixture;
    const { item } = yield* listed;
    const result = yield* reclaim.clean({
      items: [{ id: item?.id ?? "", token: item?.token ?? "" }],
      actor: "test",
    });
    expect(result.results).toMatchObject([{ outcome: "removed", path: folder }]);
    expect(yield* fs.exists(folder)).toBe(false);
  }).pipe(Effect.scoped, provide),
);

it.live.each([
  {
    name: "its thread started a turn",
    change: "turn",
    reason: "Its thread is working in it now",
  },
  {
    name: "another thread started using it",
    change: "thread",
    reason: "A thread started using it after it was reviewed",
  },
] as const)(
  "keeps a chosen No project folder when $name after it was listed",
  ({ change, reason }) =>
    Effect.gen(function* () {
      const { fs, path, folder, bind, reclaim, listed } = yield* scratchFixture;
      const { item } = yield* listed;
      expect(item?.state).toBe("removable");
      // The clean's own scan lists processes once; the change lands after it, before deletion.
      machine.onProcessListing = {
        after: 1,
        run:
          change === "turn"
            ? bind("thread-notes", "Notes", { activeRunId: "run-2", status: "running" })
            : change === "thread"
              ? bind("thread-other", "Other")
              : Effect.sync(() => {
                  machine.cwds = [folder];
                }),
      };
      const result = yield* reclaim.clean({
        items: [{ id: item?.id ?? "", token: item?.token ?? "" }],
        actor: "test",
      });
      expect(result.results[0]).toMatchObject({ outcome: "skipped", reason });
      expect(yield* fs.readFileString(path.join(folder, "notes.md"))).toBe("draft\n");
    }).pipe(Effect.scoped, provide),
);

it.live("keeps a chosen No project folder while a terminal works in it", () =>
  Effect.gen(function* () {
    const { fs, path, folder, reclaim, listed } = yield* scratchFixture;
    const { item } = yield* listed;
    expect(item?.state).toBe("removable");
    // A terminal holds its folder's workspace lease while it starts and runs (withTerminalLease).
    const opened = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const terminal = yield* withWorkspaceLease(
      folder,
      Deferred.succeed(opened, undefined).pipe(Effect.andThen(Deferred.await(closed))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(opened);
    const result = yield* reclaim.clean({
      items: [{ id: item?.id ?? "", token: item?.token ?? "" }],
      actor: "test",
    });
    yield* Deferred.succeed(closed, undefined);
    yield* Fiber.join(terminal);
    expect(result.results[0]).toMatchObject({
      outcome: "skipped",
      reason: "Something on this or another GOAT server is working inside it",
    });
    expect(yield* fs.readFileString(path.join(folder, "notes.md"))).toBe("draft\n");
  }).pipe(Effect.scoped, provide),
);
