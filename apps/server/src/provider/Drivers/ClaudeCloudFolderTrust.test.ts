import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { ClaudeCloudCli, type ClaudeCloudLogin } from "@goat/provider-claude-cloud/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import {
  MainCheckoutUnknownError,
  makeClaudeCloudFolderTrust,
  trustedInClaudeConfig,
} from "./ClaudeCloudFolderTrust.ts";

const ROOT = "/fixture/goat";
const WORKTREE = "/fixture/worktrees/goat/feature";
// Registered as projects, but inside a repository whose main checkout is not.
const STRAY_WORKTREE = "/fixture/worktrees/stray/feature";
const SUBFOLDER = "/fixture/unregistered/apps/server";
// Registered, but Git could not say where its checkout is.
const UNRESOLVED = "/fixture/unresolved";
const live = ProjectId.make("project:goat");
const deleted = ProjectId.make("project:gone");

it.effect("reads trust from Claude's config for the folder or a folder above it", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const config = JSON.stringify({
      projects: {
        "/fixture": { hasTrustDialogAccepted: true },
        "/other/repo": { hasTrustDialogAccepted: false },
      },
    });
    assert.deepEqual(
      [
        trustedInClaudeConfig(config, "/fixture/goat", path),
        trustedInClaudeConfig(config, "/other/repo", path),
        trustedInClaudeConfig(config, "/elsewhere", path),
        trustedInClaudeConfig("{}", "/fixture/goat", path),
        trustedInClaudeConfig("not json", "/fixture/goat", path),
        trustedInClaudeConfig('{"projects":3}', "/fixture/goat", path),
      ],
      [true, false, false, false, null, null],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const harness = (
  options: {
    readonly configJson?: string;
    readonly claudeRecords?: boolean;
    /** Holds Claude on its prompt until released. */
    readonly gate?: {
      readonly opened: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped();
    if (options.configJson !== undefined)
      yield* fileSystem.writeFileString(path.join(home, ".claude.json"), options.configJson);
    const accepted: string[] = [];
    const projects = ProjectStore.ProjectStoreV2.of({
      findActiveByWorkspaceRoot: (root: string) =>
        Effect.succeed(
          root === ROOT || root === STRAY_WORKTREE || root === SUBFOLDER || root === UNRESOLVED
            ? Option.some({ projectId: live } as never)
            : Option.none(),
        ),
      list: () =>
        Effect.succeed([
          { projectId: live, deletedAt: null },
          { projectId: deleted, deletedAt: "2026-10-01T00:00:00.000Z" },
        ] as never),
    } as never);
    const projection = Projection.ProjectionStoreV2.of({
      getShellSnapshot: () =>
        Effect.succeed({
          threads: [
            { projectId: live, worktreePath: WORKTREE },
            { projectId: deleted, worktreePath: "/fixture/worktrees/gone" },
          ],
          archivedThreads: [],
        } as never),
    } as never);
    const cli = ClaudeCloudCli.ClaudeCloudCli.of({
      // Like Claude: choosing Yes writes the folder's trust into its own config.
      acceptTrust: (_login: ClaudeCloudLogin, cwd: string) =>
        Effect.gen(function* () {
          accepted.push(cwd);
          if (options.gate) {
            yield* Deferred.succeed(options.gate.opened, undefined);
            yield* Deferred.await(options.gate.release);
          }
          if (options.claudeRecords === false) return;
          yield* fileSystem
            .writeFileString(
              path.join(home, ".claude.json"),
              JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
            )
            .pipe(Effect.orDie);
        }),
    } as never);
    const trust = yield* makeClaudeCloudFolderTrust({
      instanceId: ProviderInstanceId.make("claudeCloud"),
      sql,
      projects,
      projection,
      fileSystem,
      path,
      resolveLogin: Effect.succeed({
        binary: "/fixture/claude",
        binding: "fixture",
        environment: { HOME: "/fixture/home", CLAUDE_CONFIG_DIR: home },
      }),
      cli,
      // GOAT worktrees of the fixture project share its main checkout.
      mainCheckout: (cwd) =>
        cwd === UNRESOLVED
          ? Effect.fail(new MainCheckoutUnknownError({}))
          : Effect.succeed(
              cwd === WORKTREE
                ? ROOT
                : cwd === STRAY_WORKTREE
                  ? "/fixture/stray"
                  : cwd === SUBFOLDER
                    ? "/fixture/unregistered"
                    : null,
            ),
    });
    return { trust, accepted, sql };
  });

const layer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

it.effect("trusts only live project folders and their GOAT worktrees", () =>
  Effect.gen(function* () {
    const { trust } = yield* harness();
    assert.deepEqual(
      yield* Effect.forEach(
        [
          ROOT,
          WORKTREE,
          "/fixture/worktrees/gone",
          "/tmp/elsewhere",
          STRAY_WORKTREE,
          SUBFOLDER,
          UNRESOLVED,
        ],
        trust.policy.allowed,
      ),
      // Claude would record the next two at unregistered checkouts; the last root is unknown.
      [true, true, false, false, false, false, false],
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

const auditRows = (sql: SqlClient.SqlClient) =>
  sql<{ actor: string; action: string; target: string; outcome: string }>`
    SELECT actor, action, target, outcome FROM audit_events`;

it.effect("records each launch-time acceptance in the audit log", () =>
  Effect.gen(function* () {
    const { trust, sql } = yield* harness({ configJson: JSON.stringify({ projects: {} }) });
    yield* trust.policy.record({ cwd: ROOT, threadId: ThreadId.make("thread-1"), prompts: 1 });
    assert.deepEqual(yield* auditRows(sql), [
      {
        actor: "thread:thread-1",
        action: "claudeCloud.folderTrust.accept",
        target: ROOT,
        outcome: "accepted",
      },
    ]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("an untrusted project folder becomes trusted with nobody asking", () =>
  Effect.gen(function* () {
    const { trust, accepted, sql } = yield* harness({ configJson: "{}" });
    yield* trust.capability.ensure(ROOT);
    assert.deepEqual(accepted, [ROOT]);
    assert.deepEqual(yield* auditRows(sql), [
      {
        actor: "goat",
        action: "claudeCloud.folderTrust.accept",
        target: ROOT,
        outcome: "accepted",
      },
    ]);
    // Claude's config now holds the answer, so asking again does not reopen Claude.
    yield* trust.capability.ensure(ROOT);
    assert.deepEqual(accepted, [ROOT]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("concurrent requests for one folder open Claude once", () =>
  Effect.gen(function* () {
    const gate = { opened: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    // Claude records nothing here, so a request that did not join would open Claude again.
    const { trust, accepted } = yield* harness({ configJson: "{}", claudeRecords: false, gate });
    const first = yield* trust.capability.ensure(ROOT).pipe(Effect.forkChild);
    yield* Deferred.await(gate.opened);
    // Runs until it waits, so it has joined before Claude answers the first.
    const second = yield* trust.capability
      .ensure(`${ROOT}/`)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.deepEqual(accepted, [ROOT]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a refused launch joins a background answer instead of opening Claude again", () =>
  Effect.gen(function* () {
    const gate = { opened: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() };
    // Claude records nothing here, so a launch that did not join would open Claude again.
    const { trust, accepted } = yield* harness({ configJson: "{}", claudeRecords: false, gate });
    const background = yield* trust.capability.ensure(ROOT).pipe(Effect.forkChild);
    yield* Deferred.await(gate.opened);
    const launch = yield* trust.policy
      .accept(ROOT)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(background);
    yield* Fiber.join(launch);
    assert.deepEqual(accepted, [ROOT]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("still reports folder state and GOAT's last acceptance to older clients", () =>
  Effect.gen(function* () {
    const { trust } = yield* harness({ configJson: "{}" });
    assert.deepEqual(yield* trust.capability.states([ROOT]), [
      { trusted: false, acceptedByGoatAt: null },
    ]);
    yield* trust.capability.ensure(ROOT);
    const [state] = yield* trust.capability.states([ROOT]);
    assert.equal(state?.trusted, true);
    assert.isString(state?.acceptedByGoatAt);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("never accepts a folder outside GOAT's projects and their worktrees", () =>
  Effect.gen(function* () {
    const { trust, accepted, sql } = yield* harness({ configJson: "{}" });
    yield* Effect.forEach(
      ["/tmp/elsewhere", "/fixture/worktrees/gone", STRAY_WORKTREE, SUBFOLDER, UNRESOLVED],
      trust.capability.ensure,
    );
    assert.deepEqual(accepted, []);
    assert.deepEqual(yield* auditRows(sql), []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a failed acceptance is logged, not returned, and leaves no audit row", () =>
  Effect.gen(function* () {
    const { trust, accepted, sql } = yield* harness({ configJson: "{}", claudeRecords: false });
    yield* trust.capability.ensure(ROOT);
    assert.deepEqual(accepted, [ROOT]);
    assert.deepEqual(yield* auditRows(sql), []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("a worktree is trusted when Claude trusts its main checkout", () =>
  Effect.gen(function* () {
    const { trust, accepted } = yield* harness({
      configJson: JSON.stringify({ projects: { [ROOT]: { hasTrustDialogAccepted: true } } }),
    });
    yield* Effect.forEach([ROOT, WORKTREE], trust.capability.ensure);
    assert.deepEqual(accepted, []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
