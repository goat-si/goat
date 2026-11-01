import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import { REMOTE_COPY } from "./ChannelRemoteWorkers.ts";
import { goatInput, makeHarness, rpcContext, setupBot } from "./testkit/ChannelHarness.ts";
import { RemoteMachine, remoteScript, until } from "./testing/RemoteMachine.ts";

/**
 * The configured GOAT Bot model reaches work the bot sends to another machine. The other
 * machine's untargeted orchestrator_capabilities listing is truncated, so the model check
 * re-asks with a search before it may ask the requester.
 */

const codex = ProviderInstanceId.make("codex");
const lunaSelection = { instanceId: codex, model: "gpt-6-luna" } as const;
const astraSelection = { instanceId: codex, model: "gpt-6-astra" } as const;
const remoteDefault = { instanceId: codex, model: "remote-default" } as const;

/** The bot configured for astra, no project or server default in the way. */
const botHarness = () => {
  const machine = new RemoteMachine();
  const harness = makeHarness({
    sshRemote: machine.layer,
    shellDefaultModel: null,
    settingsLayer: ServerSettings.layerTest({
      textGenerationModelSelection: lunaSelection,
      goatBotModelSelection: astraSelection,
      defaultRuntimeMode: "full-access",
    }).pipe(Layer.orDie),
  });
  harness.script.current = remoteScript;
  return { machine, harness };
};

describe("the configured GOAT Bot model on another machine", () => {
  it.effect("launches on a bot model the untargeted capabilities listing omitted", () => {
    const { machine, harness } = botHarness();
    machine.offeredModels = [
      { instance: "codex", model: "gpt-6.1-sol" },
      { instance: "codex", model: "gpt-6-astra" },
    ];
    machine.omittedFromUntargetedCatalog = ["gpt-6-astra"];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: build it", "bm1"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]?.modelSelection?.model, "gpt-6-astra");
      assert.deepStrictEqual(
        machine.calls
          .filter((call) => call.tool === "orchestrator_capabilities")
          .map((call) => call.arguments),
        [{}, { search: "gpt-6-astra" }],
      );
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("asks when the bot model is not offered there at all", () => {
    const { machine, harness } = botHarness();
    machine.offeredModels = [{ instance: "codex", model: "gpt-6.1-sol" }];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: build it", "bm2"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.defaultModelMissing(machine.host, "goat-si/goat"),
      );
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("keeps asking when the other GOAT is too old to pin an exact match", () => {
    const { machine, harness } = botHarness();
    machine.offeredModels = [
      { instance: "codex", model: "gpt-6.1-sol" },
      { instance: "codex", model: "gpt-6-astra" },
    ];
    machine.omittedFromUntargetedCatalog = ["gpt-6-astra"];
    machine.capabilitiesPinsExact = false;
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: build it", "bm3"), rpcContext);
      const asked = yield* until("asked", (task) => task.status === "waiting_input");
      assert.strictEqual(
        asked.openQuestions[0]?.text,
        REMOTE_COPY.defaultModelMissing(machine.host, "goat-si/goat"),
      );
      assert.strictEqual(machine.launches.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("the remote project's default still wins over the configured bot model", () => {
    const { machine, harness } = botHarness();
    machine.projects = machine.projects.map((project) => ({
      ...project,
      defaultModelSelection: remoteDefault as never,
    }));
    machine.offeredModels = [
      { instance: "codex", model: "remote-default" },
      { instance: "codex", model: "gpt-6-astra" },
    ];
    return Effect.gen(function* () {
      yield* setupBot;
      const gateway = yield* ChannelGateway.ChannelGateway;
      yield* gateway.ingest(goatInput("do@mac-studio: build it", "bm4"), rpcContext);
      yield* until("running", (task) => task.status === "running");
      assert.strictEqual(machine.launches[0]?.modelSelection?.model, "remote-default");
    }).pipe(Effect.provide(harness.layer));
  });
});
