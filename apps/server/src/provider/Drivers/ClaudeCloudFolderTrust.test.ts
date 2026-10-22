import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import { ClaudeCloudCli } from "@goat/provider-claude-cloud/server";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Projection from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { makeClaudeCloudFolderTrust, trustedInClaudeConfig } from "./ClaudeCloudFolderTrust.ts";

const ROOT = "/fixture/goat";
const WORKTREE = "/fixture/worktrees/goat/feature";
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

const harness = (options: { readonly configJson?: string } = {}) =>
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
        Effect.succeed(root === ROOT ? Option.some({ projectId: live } as never) : Option.none()),
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
      acceptTrust: (_login, cwd) =>
        Effect.sync(() => {
          accepted.push(cwd);
        }),
    } as never);
    const trust = makeClaudeCloudFolderTrust({
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
    });
    return { trust, accepted, sql };
  });

const layer = Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer);

it.effect("trusts only live project folders and their GOAT worktrees", () =>
  Effect.gen(function* () {
    const { trust } = yield* harness();
    assert.deepEqual(
      yield* Effect.forEach(
        [ROOT, WORKTREE, "/fixture/worktrees/gone", "/tmp/elsewhere"],
        trust.policy.allowed,
      ),
      [true, true, false, false],
    );
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("records each acceptance in the audit log and reports it as trust state", () =>
  Effect.gen(function* () {
    const { trust, sql } = yield* harness({ configJson: JSON.stringify({ projects: {} }) });
    assert.deepEqual(yield* trust.capability.states([ROOT]), [
      { trusted: false, acceptedByGoatAt: null },
    ]);
    yield* trust.policy.record({ cwd: ROOT, threadId: ThreadId.make("thread-1"), prompts: 1 });
    const rows = yield* sql<{ actor: string; action: string; target: string; outcome: string }>`
      SELECT actor, action, target, outcome FROM audit_events`;
    assert.deepEqual(rows, [
      {
        actor: "thread:thread-1",
        action: "claudeCloud.folderTrust.accept",
        target: ROOT,
        outcome: "accepted",
      },
    ]);
    const [state] = yield* trust.capability.states([ROOT]);
    assert.isString(state?.acceptedByGoatAt);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("Trust now answers the prompt once, skips trusted folders and refuses others", () =>
  Effect.gen(function* () {
    const untrusted = yield* harness({ configJson: "{}" });
    yield* untrusted.trust.capability.accept(ROOT);
    assert.deepEqual(untrusted.accepted, [ROOT]);
    const [state] = yield* untrusted.trust.capability.states([ROOT]);
    assert.isString(state?.acceptedByGoatAt);
    const refused = yield* untrusted.trust.capability.accept("/tmp/elsewhere").pipe(Effect.flip);
    assert.match(refused.detail, /only its own project folders/u);
    const trusted = yield* harness({
      configJson: JSON.stringify({ projects: { [ROOT]: { hasTrustDialogAccepted: true } } }),
    });
    yield* trusted.trust.capability.accept(ROOT);
    assert.deepEqual(trusted.accepted, []);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("reports unknown trust when Claude's config cannot be read", () =>
  Effect.gen(function* () {
    const { trust } = yield* harness();
    assert.deepEqual(yield* trust.capability.states([ROOT]), [
      { trusted: null, acceptedByGoatAt: null },
    ]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
