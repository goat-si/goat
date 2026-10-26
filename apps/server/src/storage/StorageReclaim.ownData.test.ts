import { describe, expect, it } from "@effect/vitest";
import { type StorageItem } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { pinnedRuntimeVersionsDir } from "../cloud/pinnedRuntime.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  backdate,
  buildOutputWorktree,
  layer,
  LONG_AGO,
  machine,
  setup,
} from "./StorageReclaim.testkit.ts";

describe("StorageReclaim leaves GOAT's own data alone", () => {
  it.live("keeps an old runtime a thread was launched into", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      for (const version of ["0.0.1", "0.0.2"]) {
        const directory = path.join(versions, version);
        yield* fs.makeDirectory(path.join(directory, "notes"), { recursive: true });
        const sentinel = path.join(directory, ".install-complete");
        yield* fs.writeFileString(sentinel, version + "\n");
        yield* fs.utimes(sentinel, version === "0.0.1" ? 1 : 2, version === "0.0.1" ? 1 : 2);
      }
      const oldest = path.join(versions, "0.0.1");
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find((item) => item.kind === "runtime_version" && item.path === oldest),
            ),
          );
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      yield* fs.writeFileString(path.join(oldest, "notes", "findings.md"), "what broke\n");
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('thread-in-runtime', 'project', 'Runtime', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          ${JSON.stringify({ worktreePath: path.join(oldest, "notes") })})
      `;
      expect(yield* runtime()).toMatchObject({
        state: "protected",
        reason: "A thread or project on this server uses it",
      });
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(oldest, "notes", "findings.md"))).toBe(
        "what broke\n",
      );
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("removes only the runtime folder a person chose, never past it", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim, outside } = yield* setup;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      const install = (root: string, version: string, at: number) =>
        Effect.gen(function* () {
          const directory = path.join(root, version);
          yield* fs.makeDirectory(path.join(directory, "notes"), { recursive: true });
          const sentinel = path.join(directory, ".install-complete");
          yield* fs.writeFileString(sentinel, version + "\n");
          yield* fs.utimes(sentinel, at, at);
        });
      yield* install(versions, "0.0.1", 1);
      yield* install(versions, "0.0.2", 2);
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find(
                (item) => item.kind === "runtime_version" && item.path.endsWith("0.0.1"),
              ),
            ),
          );
      const clean = (item: StorageItem) =>
        reclaim
          .clean({ items: [{ id: item.id, token: item.token }], actor: "test" })
          .pipe(Effect.map((result) => result.results[0]));

      // An earlier removal's leftover, with someone's notes in it, is not part of the approval.
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      const leftover = path.join(versions, ".pruned-0.0.1");
      yield* fs.makeDirectory(leftover);
      yield* fs.writeFileString(path.join(leftover, "kept.md"), "notes\n");
      expect((yield* clean(offered))?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(leftover, "kept.md"))).toBe("notes\n");
      expect(yield* runtime()).toMatchObject({ state: "needs_attention" });
      yield* fs.remove(leftover, { recursive: true });

      // The versions folder swapped for a link to runtimes outside the GOAT home.
      const reviewed = (yield* runtime())!;
      expect(reviewed.state).toBe("removable");
      const elsewhere = path.join(outside, "versions");
      yield* fs.rename(versions, elsewhere);
      yield* fs.symlink(elsewhere, versions);
      expect((yield* clean(reviewed))?.outcome).toBe("skipped");
      expect(yield* fs.exists(path.join(elsewhere, "0.0.1", "notes"))).toBe(true);
      expect(yield* runtime()).toMatchObject({
        state: "needs_attention",
        reason: "It is reached through a link inside the GOAT home",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live(
    "never takes GOAT's own data for leftovers when the worktrees folder is the GOAT home",
    () =>
      Effect.gen(function* () {
        const { fs, path, config, reclaim } = yield* setup;
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
          worktreesDirectory: config.baseDir,
        });
        const runtime = path.join(pinnedRuntimeVersionsDir(path, config.baseDir), "0.0.1");
        yield* fs.makeDirectory(runtime, { recursive: true });
        yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
        yield* fs.writeFileString(path.join(config.attachmentsDir, "kept.png"), "image\n");
        const stray = path.join(config.baseDir, "some-repo", "old-checkout");
        yield* fs.makeDirectory(stray, { recursive: true });
        yield* fs.writeFileString(path.join(stray, "notes.txt"), "old\n");
        yield* backdate(config.baseDir);

        const leftovers = (yield* reclaim.usage({ rescan: true })).items.filter(
          (item) => item.kind === "orphan_folder" && item.path.startsWith(config.baseDir),
        );
        // Inside a GOAT home only its worktrees folders hold leftovers: runtimes, state, logs,
        // attachments and anything else of the home stay, and the default worktrees folder inside
        // it is scanned as itself.
        expect(leftovers.map((item) => path.relative(config.baseDir, item.path))).toEqual([
          path.join("worktrees", "goat", "old-branch"),
        ]);
      }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("never offers another GOAT server's home or anything of it outside its worktrees", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find, outside } = yield* setup;
      // Another server's home, made the worktrees folder here: its runtime is not a leftover.
      const otherHome = path.join(outside, "other-home");
      yield* fs.makeDirectory(path.join(otherHome, "userdata"), { recursive: true });
      yield* fs.writeFileString(path.join(otherHome, "userdata", "statev2.sqlite"), "");
      yield* fs.makeDirectory(path.join(otherHome, "runtime", "goat", "versions", "0.0.1"), {
        recursive: true,
      });
      yield* backdate(otherHome);
      // A clean, pushed worktree whose ignored folders hold a GOAT home.
      const { checkout, output, uses } = yield* buildOutputWorktree(worktrees);
      const nestedHome = path.join(output, ".goat");
      yield* fs.makeDirectory(path.join(nestedHome, "userdata"), { recursive: true });
      machine.others = {
        ...machine.others,
        databases: [
          path.join(otherHome, "userdata", "statev2.sqlite"),
          path.join(nestedHome, "userdata", "statev2.sqlite"),
        ],
      };
      machine.facts = uses(true).map((fact) => ({
        ...fact,
        entry: { ...fact.entry, dirtyCount: 0 },
      }));
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        worktreesDirectory: otherHome,
      });
      const items = (yield* reclaim.usage({ rescan: true })).items;
      expect(items.filter((item) => item.path.startsWith(otherHome))).toEqual([]);
      expect(find(items, checkout)).toMatchObject({
        state: "protected",
        reason: expect.stringMatching(/^It holds (a GOAT home|GOAT's own data)$/),
      });
      expect(find(items, output)).toMatchObject({
        state: "protected",
        reason: expect.stringMatching(/^It holds (a GOAT home|GOAT's own data)$/),
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps rotated logs while a thread works in the logs folder", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        storageCleanup: { logsAfterDays: 7 },
      });
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      const rotated = path.join(config.logsDir, "server.log.1");
      yield* fs.writeFileString(rotated, "old log\n");
      yield* fs.utimes(rotated, LONG_AGO, LONG_AGO);
      const logs = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(Effect.map((report) => report.items.find((item) => item.kind === "rotated_logs")));
      const offered = (yield* logs())!;
      expect(offered.state).toBe("removable");
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('thread-in-logs', 'project', 'Logs', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          ${JSON.stringify({ worktreePath: config.logsDir })})
      `;
      expect(yield* logs()).toMatchObject({
        state: "protected",
        reason: "A thread works in this folder",
      });
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(rotated)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps an old runtime that holds another GOAT server's home", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      for (const version of ["0.0.1", "0.0.2"]) {
        const sentinel = path.join(versions, version, ".install-complete");
        yield* fs.makeDirectory(path.dirname(sentinel), { recursive: true });
        yield* fs.writeFileString(sentinel, version + "\n");
        yield* fs.utimes(sentinel, version === "0.0.1" ? 1 : 2, version === "0.0.1" ? 1 : 2);
      }
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find(
                (item) => item.kind === "runtime_version" && item.path.endsWith("0.0.1"),
              ),
            ),
          );
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      // Another server's home inside it, found once that server is running.
      const database = path.join(versions, "0.0.1", "other-home", "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(database), { recursive: true });
      yield* fs.writeFileString(database, "");
      machine.others = { ...machine.others, databases: [database] };
      expect(yield* runtime()).toMatchObject({
        state: "protected",
        reason: "It holds another GOAT server's home or data",
      });
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(database)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps a worktree another server records by its real path, not the one git lists", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find, outside } = yield* setup;
      const realCheckout = path.join(outside, "moved-checkout");
      yield* fs.makeDirectory(realCheckout);
      const listed = path.join(worktrees, "goat", "moved");
      yield* fs.symlink(realCheckout, listed);
      machine.facts = [
        {
          entry: {
            path: listed,
            repository: path.join(worktrees, "repo"),
            branch: "moved",
            main: false,
            missing: false,
            managed: true,
            threads: [],
            dirtyCount: 0,
            aheadCount: 0,
          },
          head: "abc",
          holdsProject: false,
          leaseKeys: [listed],
        },
      ];
      machine.others = { ...machine.others, worktreePaths: [realCheckout] };
      expect(find((yield* reclaim.usage({ rescan: true })).items, listed)).toMatchObject({
        state: "protected",
        reason: "A thread of another GOAT server on this machine uses it",
      });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps an old runtime once a git checkout appears in it", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      for (const version of ["0.0.1", "0.0.2"]) {
        const sentinel = path.join(versions, version, ".install-complete");
        yield* fs.makeDirectory(path.dirname(sentinel), { recursive: true });
        yield* fs.writeFileString(sentinel, version + "\n");
        yield* fs.utimes(sentinel, version === "0.0.1" ? 1 : 2, version === "0.0.1" ? 1 : 2);
      }
      const runtime = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(
            Effect.map((report) =>
              report.items.find(
                (item) => item.kind === "runtime_version" && item.path.endsWith("0.0.1"),
              ),
            ),
          );
      const offered = (yield* runtime())!;
      expect(offered.state).toBe("removable");
      // A checkout added inside it after review, with an edit in it.
      const checkout = path.join(versions, "0.0.1", "checkout");
      yield* fs.makeDirectory(path.join(checkout, ".git"), { recursive: true });
      yield* fs.writeFileString(path.join(checkout, "work.ts"), "edited\n");
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(path.join(checkout, "work.ts"))).toBe("edited\n");
      expect(yield* runtime()).toMatchObject({ state: "needs_attention" });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("never takes a checkout's files for rotated logs", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        storageCleanup: { logsAfterDays: 7 },
      });
      const write = (file: string) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "log\n");
          yield* fs.utimes(file, LONG_AGO, LONG_AGO);
        });
      // A checkout under the logs folder whose tracked file looks like a rotated log.
      const inCheckout = path.join(config.logsDir, "evidence", "evidence.log.1");
      yield* fs.makeDirectory(path.join(config.logsDir, "evidence", ".git"), { recursive: true });
      yield* write(inCheckout);
      const rotated = path.join(config.logsDir, "archive", "server.log.1");
      yield* write(rotated);
      const logs = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(Effect.map((report) => report.items.find((item) => item.kind === "rotated_logs")));
      const offered = (yield* logs())!;
      expect(offered).toMatchObject({ state: "removable", label: "1 rotated log files" });
      // The folder of the offered log becomes a checkout after review.
      yield* fs.makeDirectory(path.join(config.logsDir, "archive", ".git"));
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      for (const file of [inCheckout, rotated]) expect(yield* fs.exists(file)).toBe(true);
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps a build output that sits in a checkout nested in its worktree", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, reclaim, find } = yield* setup;
      const { checkout, uses, git } = yield* buildOutputWorktree(worktrees);
      yield* fs.writeFileString(path.join(checkout, ".gitignore"), "node_modules/\nvendor/\n");
      machine.facts = uses(true);
      const crate = (name: string) =>
        Effect.gen(function* () {
          const folder = path.join(checkout, "vendor", name);
          yield* fs.makeDirectory(path.join(folder, "target"), { recursive: true });
          yield* fs.writeFileString(path.join(folder, "Cargo.toml"), "[package]\n");
          yield* fs.writeFileString(path.join(folder, "target", "work.rs"), "edited\n");
          return folder;
        });
      // vendor/a is its own checkout already; vendor/b becomes one after review.
      const a = yield* crate("a");
      yield* git(["-C", a, "init", "-q"]);
      const b = yield* crate("b");
      const items = (yield* reclaim.usage({ rescan: true })).items;
      expect(find(items, path.join(a, "target"))).toBeUndefined();
      const offered = find(items, path.join(b, "target"))!;
      expect(offered.state).toBe("removable");
      yield* git(["-C", b, "init", "-q"]);
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      for (const folder of [a, b])
        expect(yield* fs.readFileString(path.join(folder, "target", "work.rs"))).toBe("edited\n");
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("never takes a repository's folders for leftovers when worktrees live inside it", () =>
    Effect.gen(function* () {
      const { fs, path, worktrees, leftover, outside, reclaim, find } = yield* setup;
      const offered = find((yield* reclaim.usage({ rescan: true })).items, leftover)!;
      expect(offered.state).toBe("removable");
      // A repository set as the worktrees folder: its old source folders are its work.
      const repository = path.join(outside, "repository");
      const source = path.join(repository, "packages", "app");
      yield* fs.makeDirectory(path.join(repository, ".git"), { recursive: true });
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(path.join(source, "work.ts"), "edited\n");
      yield* backdate(repository);
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        worktreesDirectory: repository,
      });
      const items = (yield* reclaim.usage({ rescan: true })).items;
      expect(items.filter((item) => item.path.startsWith(repository))).toEqual([]);
      // The reviewed leftover's folder of checkouts turns out to be a checkout itself.
      yield* fs.makeDirectory(path.join(worktrees, "goat", ".git"));
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.exists(leftover)).toBe(true);
      expect(yield* fs.readFileString(path.join(source, "work.ts"))).toBe("edited\n");
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps rotated logs once the GOAT home turns out to be in a checkout", () =>
    Effect.gen(function* () {
      const { fs, path, config, reclaim } = yield* setup;
      yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
        storageCleanup: { logsAfterDays: 7 },
      });
      const log = path.join(config.logsDir, "evidence.log.1");
      yield* fs.makeDirectory(config.logsDir, { recursive: true });
      yield* fs.writeFileString(log, "tracked and edited\n");
      yield* fs.utimes(log, LONG_AGO, LONG_AGO);
      const logs = () =>
        reclaim
          .usage({ rescan: true })
          .pipe(Effect.map((report) => report.items.find((item) => item.kind === "rotated_logs")));
      const offered = (yield* logs())!;
      expect(offered.state).toBe("removable");
      // A repository at the home: its logs folder's files can be that repository's work.
      yield* fs.makeDirectory(path.join(config.baseDir, ".git"));
      const result = yield* reclaim.clean({
        items: [{ id: offered.id, token: offered.token }],
        actor: "test",
      });
      expect(result.results[0]?.outcome).toBe("skipped");
      expect(yield* fs.readFileString(log)).toBe("tracked and edited\n");
      expect(yield* logs()).toMatchObject({ state: "needs_attention" });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );

  it.live("keeps runtimes, worktrees and build outputs once a checkout appears around them", () =>
    Effect.gen(function* () {
      const { fs, path, config, worktrees, reclaim, find } = yield* setup;
      const versions = pinnedRuntimeVersionsDir(path, config.baseDir);
      for (const version of ["0.0.1", "0.0.2"]) {
        const sentinel = path.join(versions, version, ".install-complete");
        yield* fs.makeDirectory(path.dirname(sentinel), { recursive: true });
        yield* fs.writeFileString(sentinel, version + "\n");
        yield* fs.utimes(sentinel, version === "0.0.1" ? 1 : 2, version === "0.0.1" ? 1 : 2);
      }
      const notes = path.join(versions, "0.0.1", "notes.txt");
      yield* fs.writeFileString(notes, "tracked and edited\n");
      const { checkout, output } = yield* buildOutputWorktree(worktrees);
      machine.facts = [
        {
          entry: {
            path: checkout,
            repository: path.join(worktrees, "repo"),
            branch: "idle-branch",
            main: false,
            missing: false,
            managed: true,
            threads: [],
            dirtyCount: 0,
            aheadCount: 0,
          },
          head: "abc",
          holdsProject: false,
          leaseKeys: [checkout],
        },
      ];
      const targets = [path.join(versions, "0.0.1"), checkout, output];
      const items = (yield* reclaim.usage({ rescan: true })).items;
      const offered = targets.map((target) => find(items, target)!);
      expect(offered.map((item) => item.state)).toEqual(["removable", "removable", "removable"]);
      // The GOAT home turns out to be in a repository, which may track any of their files.
      yield* fs.makeDirectory(path.join(config.baseDir, ".git"));
      const result = yield* reclaim.clean({
        items: offered.map((item) => ({ id: item.id, token: item.token })),
        actor: "test",
      });
      expect(result.results.map((entry) => entry.outcome)).toEqual([
        "skipped",
        "skipped",
        "skipped",
      ]);
      expect(yield* fs.readFileString(notes)).toBe("tracked and edited\n");
      for (const target of targets) expect(yield* fs.exists(target)).toBe(true);
      const again = (yield* reclaim.usage({ rescan: true })).items;
      for (const target of targets)
        expect(find(again, target)).toMatchObject({ state: "needs_attention" });
    }).pipe(Effect.provide(layer(process.env.TMPDIR ?? "/tmp")), Effect.scoped),
  );
});
