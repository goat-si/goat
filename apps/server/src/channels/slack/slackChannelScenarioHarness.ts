import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert } from "@effect/vitest";
import { type BotId, type RuntimeMode } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ChannelBotMembers from "../ChannelBotMembers.ts";
import * as ChannelIdentityService from "../ChannelIdentityService.ts";
import * as ChannelLayers from "../ChannelLayers.ts";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelRuntime from "../ChannelRuntime.ts";
import { inputIdFor } from "../channelIds.ts";
import { makeHarness, owner, ownerId } from "../testkit/ChannelHarness.ts";
import * as SlackChannelSettingsLive from "./SlackChannelSettings.live.ts";
import * as SlackChannelRuntime from "./SlackChannelRuntime.ts";
import { directMessage, eventCallback } from "./slackChannelTestSupport.ts";
import { makeFakeSlackSdk, type FakeSlackSdk } from "./slackSdkFake.ts";

export const connectionId = "slack-1";
export const ROOT_TS = "1760000000.000100";

export const slackScenario = (options: Parameters<typeof makeHarness>[0] = {}) => {
  const sdk = makeFakeSlackSdk();
  const slack = SlackChannelSettingsLive.layer.pipe(
    Layer.provide(sdk.layer),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(SlackChannelRuntime.layer.pipe(Layer.provide(sdk.layer))),
    Layer.provide(NodeCrypto.layer),
    Layer.orDie,
  );
  const harness = makeHarness({
    ...options,
    fakeSlackTransport: false,
    channelsLayer: ChannelLayers.makeLayerServices(slack),
  });
  const layer = slack.pipe(Layer.provideMerge(harness.layer));
  return { sdk, harness, layer };
};

export const connect = Effect.fn("SlackScenario.connect")(function* (
  _sdk: FakeSlackSdk,
  options: {
    readonly botBindings?: ReadonlyArray<{ readonly channelId: string; readonly botId: BotId }>;
    readonly unlinkedRuntimeModeCeiling?: RuntimeMode;
    readonly owner?: typeof owner;
  } = {},
) {
  const runtime = yield* SlackChannelRuntime.SlackChannelRuntime;
  yield* runtime.apply({
    connectionId,
    enabled: true,
    channelScope: "listed",
    allowedChannelIds: ["C0ALLOWED"],
    appToken: "xapp-1-test",
    botToken: "xoxb-test",
    expectedTeamId: "T0TEAM",
    owner,
    ...options,
  });
  yield* runtime.streamStatus.pipe(
    Stream.filter((event) => event.connectionId === connectionId && event.status === "connected"),
    Stream.runHead,
  );
});

export const emit = (sdk: FakeSlackSdk, event: Record<string, unknown>, eventId: string) => {
  const session = sdk.sessions.at(-1);
  assert(session !== undefined);
  const envelope = session.emitEnvelope(eventCallback(event, { event_id: eventId }));
  return Effect.promise(() => envelope.acked).pipe(Effect.as(envelope));
};

export const linkAlice = Effect.fn("SlackScenario.linkAlice")(function* (
  sdk: FakeSlackSdk,
  linkOwner = owner,
) {
  const identities = yield* ChannelIdentityService.ChannelIdentityService;
  const { code } = yield* identities.createLink(
    { connectionId, runtimeModeCeiling: "auto-accept-edits" },
    linkOwner,
  );
  yield* emit(sdk, directMessage({ text: `link ${code}` }), "EvLinkAlice01");
});

export const tasks = Effect.flatMap(ChannelLedger.ChannelLedger, (ledger) =>
  ledger.listTasks({ ownerId, limit: 10 }),
);

export const createBot = (name: string) =>
  Effect.flatMap(ChannelBotMembers.ChannelBotMembers, (members) =>
    members.create(
      { clientRequestId: name, name, purpose: "", avatar: null, defaultModelSelection: null },
      owner,
    ),
  );

const eventInputId = (eventId: string) =>
  inputIdFor({ ownerId, kind: "slack", connectionId, idempotencyKey: "T0TEAM:" + eventId });

export const receive = Effect.fn("SlackScenario.receive")(function* (
  sdk: FakeSlackSdk,
  event: Record<string, unknown>,
  eventId: string,
) {
  yield* emit(sdk, event, eventId);
  yield* (yield* ChannelRuntime.ChannelRuntime).drain;
  return yield* (yield* ChannelLedger.ChannelLedger).getInput(eventInputId(eventId));
});
