import * as PermissionSettings from "../serverSettings.ts";
/**
 * Live check against a real second machine. Skipped unless GOAT_REMOTE_LIVE_HOST names an SSH
 * alias whose GOAT already runs (it is reused, never restarted) and GOAT_REMOTE_LIVE_PROJECT_ID
 * names one of its existing projects, preferably a scratch folder: the remote agent is told not
 * to change files. The remote runs codex/gpt-6.1-sol, which it must offer.
 *
 *   GOAT_REMOTE_LIVE_HOST=mac-studio GOAT_REMOTE_LIVE_PROJECT_ID=<id> \
 *     vp test run apps/server/src/channels/ChannelRemoteWorkers.live.test.ts
 *
 * Phase one dispatches a task from the GOAT bot to that machine and waits for the worker's first
 * report, then stops this side entirely (fibers, SSH tunnels, sessions). While it is down the
 * remote worker keeps going and reports again. Phase two starts a new owner on the same state
 * file: it waits out the old owner's heartbeat, reconnects with the stored binding, imports what
 * arrived meanwhile, settles the task from the remote run's end, and delivers the result to the
 * GOAT bot timeline.
 */
// @effect-diagnostics nodeBuiltinImport:off - the live check keeps its state file in the OS temp dir.
import * as NodeOS from "node:os";
// @effect-diagnostics nodeBuiltinImport:off - see above.
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { type ChannelReceptionInput, type ChannelTask, ProjectId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelRuntime from "./ChannelRuntime.ts";
import {
  botMessages,
  defaultScript,
  goatInput,
  makeHarness,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

const HOST = process.env.GOAT_REMOTE_LIVE_HOST ?? "";
const PROJECT_ID = process.env.GOAT_REMOTE_LIVE_PROJECT_ID ?? "";
// Each run is a new input: the task id, and so the remote binding id, derive from it, and the
// remote keeps bindings from earlier runs.
const RUN = process.pid + "-" + NodeOS.uptime().toFixed(0);
const DATABASE = NodePath.join(NodeOS.tmpdir(), "goat-remote-live-" + RUN + ".sqlite");

const INSTRUCTION = [
  "This is a connectivity check from another machine. Do not create, change, or delete any files.",
  "1. Call goat_origin_report with status progress and summary: remote step one.",
  "2. Run the shell command: sleep 90",
  "3. Call goat_origin_report with status completed and summary: remote pong.",
  "4. Reply with exactly: remote pong",
].join("\n");

const script = (input: ChannelReceptionInput) =>
  input.mode === "input" && input.inputText === "live"
    ? Effect.succeed({
        replyText: "Sending it to " + HOST + ".",
        action: {
          type: "create_task" as const,
          title: "Remote connectivity check",
          instruction: INSTRUCTION,
          projectId: ProjectId.make(PROJECT_ID),
          host: HOST,
        },
      })
    : defaultScript(input);

const harnessFor = () => {
  const harness = makeHarness({
    // The real SSH path: the remote's GOAT is reused, never restarted.
    sshRemote: SshRemoteDispatch.layer.pipe(
      Layer.provide(PermissionSettings.layerTest()),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-remote-live-" })),
      Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      Layer.orDie,
    ),
    databaseLayer: SqlitePersistence.layerFromPath(DATABASE).pipe(
      Layer.provide(NodeServices.layer),
    ) as never,
  });
  harness.script.current = script;
  return harness;
};

const waitFor = (label: string, check: (task: ChannelTask) => boolean, minutes: number) =>
  Effect.gen(function* () {
    const runtime = yield* ChannelRuntime.ChannelRuntime;
    const deadline = (yield* Clock.currentTimeMillis) + minutes * 60_000;
    // oxlint-disable-next-line goat/no-polling-loop-in-tests -- Opt-in real remote host exposes persisted task snapshots across origin restarts, with no local completion event.
    while ((yield* Clock.currentTimeMillis) < deadline) {
      yield* runtime.drain;
      const page = yield* (yield* ChannelLedger.ChannelLedger).listTasks({
        ownerId: rpcContext.ownerId,
        limit: 1,
      });
      const task = page.tasks[0];
      if (task !== undefined && check(task)) return task;
      if (
        task !== undefined &&
        task.status !== "completed" &&
        ["failed", "cancelled"].includes(task.status)
      ) {
        return yield* Effect.die(
          new Error(label + ": the task ended " + task.status + ": " + task.resultSummary),
        );
      }
      // oxlint-disable-next-line goat/no-real-time-wait-in-tests -- Opt-in real SSH agent reports arrive asynchronously from a second host; pace external state reads.
      yield* Effect.sleep(Duration.seconds(2));
    }
    const task = yield* onlyTask;
    return yield* Effect.die(
      new Error("timed out waiting for " + label + " (" + task.status + ")"),
    );
  });

describe.skipIf(HOST === "" || PROJECT_ID === "")("a task on a real second machine", () => {
  it.live(
    "runs there, reports back across an origin restart, and delivers the result",
    () =>
      Effect.gen(function* () {
        // Phase one: dispatch and see the first report.
        const first = yield* Effect.gen(function* () {
          yield* setupBot;
          const gateway = yield* ChannelGateway.ChannelGateway;
          yield* gateway.ingest(goatInput("live", "live-" + RUN), rpcContext);
          const running = yield* waitFor("running", (task) => task.status === "running", 5);
          yield* Effect.logInfo("live: running on " + HOST, running.worker);
          return yield* waitFor(
            "first report",
            (task) => task.resultSummary === "remote step one",
            5,
          );
        }).pipe(Effect.provide(harnessFor().layer));
        assert.strictEqual(first.worker?.host, HOST);

        // Phase two: a new owner on the same state, after this side was fully stopped.
        const second = harnessFor();
        const done = yield* Effect.gen(function* () {
          const task = yield* waitFor("completed", (task) => task.status === "completed", 10);
          // Let the narration and its delivery reach the GOAT bot.
          for (let pass = 0; pass < 10; pass += 1) {
            yield* (yield* ChannelRuntime.ChannelRuntime).drain;
            // oxlint-disable-next-line goat/no-real-time-wait-in-tests -- Opt-in real remote agent delivery crosses SSH and persisted outboxes; allow remote narration to arrive before the next drain.
            yield* Effect.sleep(Duration.seconds(1));
          }
          const records = yield* botMessages;
          return { task, texts: records.messages.map((message) => message.text) };
        }).pipe(Effect.provide(second.layer));
        yield* Effect.logInfo("live: completed", done.task.resultSummary);
        assert.strictEqual(done.task.worker?.threadId, first.worker?.threadId);
        assert.include(done.task.resultSummary ?? "", "remote pong");
        assert.isTrue(done.texts.some((text) => text.includes("remote pong")));
      }),
    20 * 60_000,
  );
});
