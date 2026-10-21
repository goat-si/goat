// @effect-diagnostics nodeBuiltinImport:off -- offline fixture CLI requires a new output directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerSettings,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../src/orchestration-v2/ProjectStore.ts";
import * as Persistence from "../src/persistence/Sqlite.ts";
import * as Ledger from "../src/channels/ChannelLedger.ts";
import * as Gateway from "../src/channels/ChannelGateway.ts";
import * as Reception from "../src/channels/ChannelReceptionService.ts";
import * as Delivery from "../src/channels/ChannelDeliveryWorker.ts";
import { commitTransition } from "../src/channels/channelTaskWrites.ts";
import {
  botThreadId,
  environmentId,
  goatInput,
  makeHarness,
  modelSelection,
  onlyTask,
  rpcContext,
  scratchProjectId,
  setupBot,
} from "../src/channels/testkit/ChannelHarness.ts";

const requested = process.argv[2];
if (!requested || !NodePath.isAbsolute(requested))
  throw new Error("Pass a NEW absolute fixture home directory.");
const fixtureHome = NodePath.resolve(requested);
const physicalHome = NodePath.join(
  await NodeFSP.realpath(NodePath.dirname(fixtureHome)),
  NodePath.basename(fixtureHome),
);
for (const name of [".goat", ".t3"]) {
  const root = NodePath.join(NodeOS.homedir(), name);
  const physicalRoot = await NodeFSP.realpath(root).catch(() => root);
  if (physicalHome === physicalRoot || physicalHome.startsWith(physicalRoot + NodePath.sep))
    throw new Error("Live GOAT home paths are not fixture destinations.");
}
// Existing directories, including any live GOAT home, are never opened or replaced.
await NodeFSP.mkdir(fixtureHome, { recursive: false, mode: 0o700 });
const stateDir = NodePath.join(fixtureHome, "userdata");
await NodeFSP.mkdir(stateDir, { recursive: false, mode: 0o700 });
const workspace = NodePath.join(fixtureHome, "synthetic-project");
await NodeFSP.mkdir(workspace);
const dbPath = NodePath.join(stateDir, "statev2.sqlite");
const databaseLayer = Persistence.layerFromPath(dbPath).pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);
const harness = makeHarness({
  databaseLayer,
  fakeSlackTransport: false,
});
const reason = "fixture-ssh · Codex · 20% weekly used (vs 80% on this machine)";
const summary =
  "Synthetic presentation fixture. No provider turn, Slack send, SSH connection, or remote dispatch occurred.";
await Effect.runPromise(
  Effect.gen(function* () {
    const fixtureTime = DateTime.formatIso(yield* DateTime.now);
    yield* ProjectStore.ProjectStoreV2.pipe(
      Effect.flatMap((projects) =>
        projects.apply({
          type: "project.created",
          sequence: 0,
          eventId: EventId.make("fixture-project"),
          aggregateKind: "project",
          aggregateId: scratchProjectId,
          occurredAt: fixtureTime,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId: scratchProjectId,
            title: "Channel placement fixture",
            workspaceRoot: workspace,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: fixtureTime,
            updatedAt: fixtureTime,
          },
        }),
      ),
      Effect.provide(ProjectStore.layer.pipe(Layer.provide(databaseLayer))),
    );
    yield* setupBot;
    const ledger = yield* Ledger.ChannelLedger;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "fixture-owner", now, staleBefore: now });
    const input = yield* (yield* Gateway.ChannelGateway).ingest(
      goatInput("do: Synthetic placement chip — display verification only", "fixture-placement"),
      rpcContext,
    );
    yield* (yield* Reception.ChannelReceptionService).receive(input.inputId, "fixture-owner");
    const task = yield* onlyTask;
    const stored = (yield* ledger.getTask(task.taskId))!;
    yield* commitTransition(
      ledger,
      stored,
      {
        type: "task.dispatch.claimed",
        payload: {
          generation: task.generation,
          leaseExpiresAt: now,
          target: {
            environmentId: EnvironmentId.make("environment:fixture-remote"),
            projectId: ProjectId.make("project:fixture-remote"),
            modelSelection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "worktree" },
            remote: { host: "fixture-ssh", cwd: "/synthetic/repo" },
            placementReason: reason,
          },
        },
      },
      { owner: "fixture-owner" },
    );
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      {
        type: "task.worker.bound",
        payload: {
          worker: {
            environmentId: EnvironmentId.make("environment:fixture-remote"),
            threadId: ThreadId.make("thread:fixture-remote"),
            runId: RunId.make("run:fixture-remote"),
            host: "fixture-ssh",
            generation: task.generation,
          },
        },
      },
      { owner: "fixture-owner" },
    );
    yield* commitTransition(
      ledger,
      (yield* ledger.getTask(task.taskId))!,
      { type: "task.completed", payload: { generation: task.generation, summary } },
      { owner: "fixture-owner" },
    );
    yield* (yield* Delivery.ChannelDeliveryWorker).deliverDue("fixture-owner");
  }).pipe(Effect.scoped, Effect.provide(harness.layer)),
);
const drivers = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "muse",
  "pi",
  "claudeCloud",
  "cursorCloud",
  "devinCloud",
];
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  channelAutoPlacement: false,
  memoryEnabled: false,
  enableProviderUpdateChecks: false,
  providerInstances: Object.fromEntries(
    drivers.map((id) => [
      ProviderInstanceId.make(id),
      { driver: ProviderDriverKind.make(id), enabled: false, config: {} },
    ]),
  ),
  goatBotHome: { environmentId, claimedAt: 1, claimId: "synthetic-channel-placement" },
} satisfies ServerSettings;
await NodeFSP.writeFile(NodePath.join(stateDir, "environment-id"), environmentId + "\n", {
  mode: 0o600,
});
const settingsPath = NodePath.join(stateDir, "settings.json");
// Settings contain decoded values such as Duration; disk stores the schema's wire representation.
const encoded = Schema.encodeSync(ServerSettings)(settings);
await NodeFSP.writeFile(settingsPath, JSON.stringify(encoded, null, 2) + "\n", { mode: 0o600 });
const persisted = Schema.decodeUnknownSync(Schema.fromJsonString(ServerSettings))(
  await NodeFSP.readFile(settingsPath, "utf8"),
);
NodeAssert.deepStrictEqual(Schema.encodeSync(ServerSettings)(persisted), encoded);
NodeAssert.equal(persisted.channelAutoPlacement, false);
NodeAssert.equal(persisted.memoryEnabled, false);
NodeAssert.ok(
  Object.values(persisted.providerInstances).every((instance) => instance.enabled === false),
);
await NodeFSP.writeFile(NodePath.join(fixtureHome, "SYNTHETIC-FIXTURE.txt"), summary + "\n");
process.stdout.write(
  JSON.stringify(
    {
      fixtureHome,
      dbPath,
      environmentId,
      botThreadId,
      placementReason: reason,
      channelAutoPlacement: persisted.channelAutoPlacement,
      synthetic: true,
    },
    null,
    2,
  ) + "\n",
);
