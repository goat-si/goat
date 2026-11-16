import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { newBotSlot, startNewBot } from "@goat/client-runtime/goatBot";
import { BotProfile, EnvironmentId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

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
import { environmentCatalog } from "../../connection/catalog";
import { environmentPresentations } from "../../state/presentation";
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useKeptPerComputer,
} from "./useKeptPerComputer";

const catalogAtom = environmentCatalog.catalogValueAtom as unknown as Atom.Writable<unknown>;
const presentationsAtom = environmentPresentations.presentationsAtom as unknown as Atom.Writable<
  ReadonlyMap<string, object>
>;
const listed = (ids: string[]) => ({
  isReady: true,
  entries: new Map(ids.map((id) => [id, { enabled: true }])),
});

function following() {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  registry.set(catalogAtom, listed(["env"]));
  return { registry, [Symbol.dispose]: stop };
}

const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const bot = (botId: string) =>
  decodeProfile({
    botId,
    role: "member",
    name: "New bot",
    avatar: null,
    purpose: "",
    defaultModelSelection: null,
    defaultProjectId: null,
    environmentId: "env",
    sessionThreadId: `thread-${botId}`,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  });

it("a connection refusal drops the created bots held for that computer, and a create answering later brings none back", async () => {
  using follow = following();
  const environmentId = EnvironmentId.make("env");
  const answers: Array<(bot: BotProfile) => void> = [];
  const create = () => new Promise<BotProfile>((resolve) => answers.push(resolve));
  startNewBot(
    environmentId,
    [],
    create,
    () => {},
    {},
    () => "first",
  );
  await act(async () => answers.shift()?.(bot("first")));
  startNewBot(
    environmentId,
    [],
    create,
    () => {},
    {},
    () => "second",
  );
  expect(newBotSlot(environmentId).created.map((held) => held.botId)).toEqual(["first"]);
  expect(newBotSlot(environmentId).operation?.phase).toBe("creating");
  follow.registry.set(
    presentationsAtom,
    new Map([
      [
        "env",
        { connection: { phase: "error", failure: { kind: "blocked", reason: "permission" } } },
      ],
    ]),
  );
  expect(newBotSlot(environmentId)).toMatchObject({ operation: null, created: [] });
  await act(async () => answers.shift()?.(bot("second")));
  expect(newBotSlot(environmentId)).toMatchObject({ operation: null, created: [] });
});

it("an open asks answer from before its computer was removed and added again is not kept", async () => {
  using follow = following();
  const { registry } = follow;
  const asks = { asks: [{ text: "Which machine?" }], total: 1, truncated: false };
  let kept: unknown = null;
  function Asks(props: { readonly online: boolean }) {
    const data = props.online ? asks : null;
    kept = useKeptPerComputer(
      "asks",
      EnvironmentId.make("env"),
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
    return null;
  }
  // Removed and added again after Needs you rendered its answer, before that render's effects ran.
  function RemoveAndReAddAfterRender() {
    useLayoutEffect(() => {
      registry.set(catalogAtom, listed([]));
      registry.set(catalogAtom, listed(["env"]));
    }, []);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <Asks online />
        <RemoveAndReAddAfterRender />
      </RegistryContext>,
    ),
  );
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <Asks online={false} />
      </RegistryContext>,
    ),
  );
  expect(kept).toBeNull();
  await act(async () => root.unmount());
});
