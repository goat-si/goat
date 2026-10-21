import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

import * as ChannelDispatcher from "./ChannelDispatcher.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import * as ChannelLedger from "./ChannelLedger.ts";
import * as ChannelReceptionService from "./ChannelReceptionService.ts";
import {
  goatInput,
  makeHarness,
  onlyTask,
  rpcContext,
  setupBot,
} from "./testkit/ChannelHarness.ts";

it.effect(
  "freezes before local launch and reuses the exact brief after interrupted acceptance",
  () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      yield* setupBot;
      const fs = yield* FileSystem.FileSystem;
      const files = channelBotFilesFor(
        yield* Path.Path,
        (yield* ServerConfig.ServerConfig).stateDir,
      );
      yield* fs.makeDirectory(files.dir, { recursive: true });
      yield* fs.writeFileString(files.notes, "abc");
      const ledger = yield* ChannelLedger.ChannelLedger;
      const gateway = yield* ChannelGateway.ChannelGateway;
      const reception = yield* ChannelReceptionService.ChannelReceptionService;
      const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* ledger.claimOwnership({ token: "local-brief-owner", now, staleBefore: now });
      const input = yield* gateway.ingest(
        goatInput("do: inspect the build", "local-brief"),
        rpcContext,
      );
      yield* reception.receive(input.inputId, "local-brief-owner");
      const task = yield* onlyTask;
      let frozenTaskVersion: number | undefined;
      harness.launch.afterAccepted = (launch) =>
        Effect.gen(function* () {
          const stored = (yield* ledger.getTask(task.taskId))!;
          const brief = yield* ledger.latestTaskBrief(task.taskId);
          assert.strictEqual(stored.task.status, "dispatching");
          assert.strictEqual(stored.task.briefVersion, 1);
          assert.strictEqual(brief?.deliveredText, launch.initialMessage?.text);
          assert.strictEqual(brief?.instruction, task.instruction);
          assert.strictEqual(brief?.intent, "inspect the build");
          assert.isDefined(brief?.context.notesPath);
          assert.strictEqual(
            brief?.context.notesRevision,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          );
          assert.isDefined(brief?.context.skillsPath);
          assert.strictEqual(brief?.target.provider, launch.modelSelection.instanceId);
          assert.strictEqual(brief?.target.model, launch.modelSelection.model);
          frozenTaskVersion = stored.task.version;
          return yield* Effect.die("simulated interruption after launch acceptance");
        }).pipe(Effect.orDie);
      const interrupted = yield* dispatcher
        .dispatch(task.taskId, "local-brief-owner")
        .pipe(Effect.exit);
      assert.strictEqual(interrupted._tag, "Failure");
      const frozen = yield* ledger.latestTaskBrief(task.taskId);
      yield* fs.writeFileString(files.notes, "changed after the first launch");
      harness.launch.afterAccepted = (launch) =>
        Effect.gen(function* () {
          assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.version, frozenTaskVersion);
          assert.deepStrictEqual(yield* ledger.latestTaskBrief(task.taskId), frozen);
          assert.strictEqual(launch.initialMessage?.text, frozen?.deliveredText);
        }).pipe(Effect.orDie);
      yield* dispatcher.dispatch(task.taskId, "local-brief-owner");
      assert.strictEqual((yield* ledger.getTask(task.taskId))?.task.status, "running");
      assert.lengthOf(harness.world.launches, 2);
      assert.strictEqual(
        harness.world.launches[0]?.commandId,
        harness.world.launches[1]?.commandId,
      );
    }).pipe(Effect.provide(harness.layer));
  },
);

it.effect("uses a ready sibling when the configured instance could not initialize", () => {
  const harness = makeHarness({
    providerInstances: [
      { instanceId: "codex", missing: true },
      { instanceId: "codex-work", weeklyUsedPercent: 20 },
    ],
  });
  return Effect.gen(function* () {
    yield* setupBot;
    const ledger = yield* ChannelLedger.ChannelLedger;
    const gateway = yield* ChannelGateway.ChannelGateway;
    const reception = yield* ChannelReceptionService.ChannelReceptionService;
    const dispatcher = yield* ChannelDispatcher.ChannelDispatcher;
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* ledger.claimOwnership({ token: "missing-provider-owner", now, staleBefore: now });
    const input = yield* gateway.ingest(
      goatInput("do: use the ready account", "missing-instance"),
      rpcContext,
    );
    yield* reception.receive(input.inputId, "missing-provider-owner");
    const task = yield* onlyTask;
    yield* dispatcher.dispatch(task.taskId, "missing-provider-owner");
    assert.strictEqual((yield* onlyTask).status, "running");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.instanceId, "codex-work");
    assert.strictEqual(harness.world.launches[0]?.modelSelection.model, "gpt-6.1-sol");
  }).pipe(Effect.provide(harness.layer));
});
