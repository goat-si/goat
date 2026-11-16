import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "@goat/client-runtime/connection";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

// Signing out touches the relay, notifications and drafts; only what it does to kept answers is under test.
vi.mock("@goat/client-runtime/relay", () => ({
  createCloudAccountService: () => ({}),
  invalidateManagedRelaySessionToken: vi.fn(),
  managedRelaySessionAtom: {},
  readmitConnectKey: vi.fn(),
  ManagedRelay: {},
  setManagedRelaySession: vi.fn(),
}));
vi.mock("@goat/client-runtime/state/runtime", () => ({
  reportAtomCommandResult: vi.fn(),
  runAtomCommand: vi.fn(),
  settleAsyncResult: vi.fn(),
  squashAtomCommandFailure: vi.fn(),
}));
vi.mock("../../lib/runtime", () => ({ runtime: {} }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerCloudAccountId: vi.fn(),
  restoreCloudComposerDrafts: vi.fn(),
}));
vi.mock("../agent-awareness/remoteRegistration", () => ({
  releaseAgentAwarenessRelayTokenProvider: vi.fn(),
  setAgentAwarenessRelayTokenProvider: vi.fn(),
  unregisterAgentAwarenessDeviceForCurrentUser: vi.fn(),
}));
vi.mock("./cloud-drafts", () => ({ removeCloudEnvironments: {} }));
vi.mock("./connectOnboarding", () => ({
  clearConnectOnboardingRequest: vi.fn(),
  requestConnectOnboarding: vi.fn(),
}));
vi.mock("./publicConfig", () => ({ resolveRelayClerkTokenOptions: vi.fn() }));
vi.mock("../../state/atom-registry", async () => {
  const { AtomRegistry } = await import("effect/reactivity");
  return { appAtomRegistry: AtomRegistry.make() };
});
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make<unknown>({ isReady: true, entries: new Map() }),
    },
  };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("../../state/channels", () => ({ channelEnvironment: { listBots: () => null } }));
// Each computer's main bot conversation, as the phone holds it.
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
const conversation = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("../../state/use-thread-detail", () => ({
  useThreadVisibleTurnItems: () => conversation.items,
}));

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { followKeptPerComputerCatalog, useKeptPerComputer } from "../goat-bot/useKeptPerComputer";
import { useMobileBotPreview } from "../goat-bot/useMobileBotPreview";
import { deactivateCloudRelayAccount } from "./cloudAccountService";

const RELAY_ONLY = EnvironmentId.make("relay-only");
const ALSO_LAN = EnvironmentId.make("also-lan");
const relayRoute = (environmentId: EnvironmentId) => ({
  target: new RelayConnectionTarget({ environmentId, label: "Desk" }),
  profile: Option.none(),
});
const catalog = {
  isReady: true,
  entries: new Map<EnvironmentId, object>([
    [RELAY_ONLY, relayRoute(RELAY_ONLY)],
    [
      ALSO_LAN,
      {
        target: new BearerConnectionTarget({
          environmentId: ALSO_LAN,
          label: "Studio",
          connectionId: "lan",
        }),
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "lan",
            environmentId: ALSO_LAN,
            label: "Studio",
            httpBaseUrl: "http://192.168.1.10:3773/",
            wsBaseUrl: "ws://192.168.1.10:3773/",
          }),
        ),
        alternateRoutes: [relayRoute(ALSO_LAN)],
      },
    ],
  ]),
};

const threadId = ThreadId.make("thread-bot");
const time = DateTime.makeUnsafe("2026-10-12T12:00:00Z");
const reply: OrchestrationV2ProjectedTurnItem = {
  position: 0,
  visibility: "local",
  sourceThreadId: threadId,
  sourceItemId: TurnItemId.make("b1"),
  item: {
    id: TurnItemId.make("b1"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: time,
    completedAt: time,
    updatedAt: time,
    messageId: MessageId.make("m-b1"),
    text: "The build is waiting on you.",
    type: "assistant_message",
    streaming: false,
  },
};

it("signing out hides, at once, the main tile line and kept bot list of a computer reached only through the relay", async () => {
  conversation.items = [reply];
  const registry = appAtomRegistry;
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(environmentCatalog.catalogValueAtom as unknown as Atom.Writable<unknown>, catalog);
  const seen = new Map<EnvironmentId, { line: string | null; bots: unknown }>();
  const bots = { bots: [{ botId: "main" }] };
  function Computer(props: { readonly environmentId: EnvironmentId; readonly online: boolean }) {
    const data = props.online ? bots : null;
    const kept = useKeptPerComputer(
      "bots",
      props.environmentId,
      {
        data,
        successResult: null,
        cause: null,
        error: null,
        isPending: false,
        isSuccess: data !== null,
        refresh: () => {},
      },
      !props.online,
    );
    const line = useMobileBotPreview({ environmentId: props.environmentId, threadId })?.text;
    seen.set(props.environmentId, { line: line ?? null, bots: kept });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const show = (online: boolean) =>
    act(async () =>
      root.render(
        <RegistryContext value={registry}>
          <Computer environmentId={RELAY_ONLY} online={online} />
          <Computer environmentId={ALSO_LAN} online={online} />
        </RegistryContext>,
      ),
    );
  await show(true);
  // The relay dropped with the account; both computers show what was kept.
  await show(false);
  expect(seen.get(RELAY_ONLY)).toEqual({ line: "The build is waiting on you.", bots });
  expect(seen.get(ALSO_LAN)).toEqual({ line: "The build is waiting on you.", bots });
  await act(async () => deactivateCloudRelayAccount());
  expect(seen.get(RELAY_ONLY)).toEqual({ line: null, bots: null });
  expect(seen.get(ALSO_LAN)).toEqual({ line: "The build is waiting on you.", bots });
  await act(async () => root.unmount());
  stop();
});
