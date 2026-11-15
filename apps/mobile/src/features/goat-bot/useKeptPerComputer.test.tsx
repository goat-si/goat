import { act } from "react";
import { createRoot } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import { EnvironmentId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

// The app's computers: five, all listed.
const computers = vi.hoisted(() => ["env1", "env2", "env3", "env4", "env5"]);
vi.mock("../../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map(computers.map((id) => [id, { enabled: true }])),
      }),
    },
  };
});
import {
  followKeptPerComputerCatalog,
  resetKeptPerComputerForTests,
  useKeptPerComputer,
} from "./useKeptPerComputer";

// One answer per bot, kept as a real read keeps its identity.
const answers = new Map<string, object>();
const answerFor = (key: string) => {
  let answer = answers.get(key);
  if (answer === undefined) answers.set(key, (answer = { waitingCount: 1, key }));
  return answer;
};

/** Member statuses for these bots, written online in order, then read back offline. */
async function keptAfterWriting(bots: ReadonlyArray<readonly [string, string]>) {
  resetKeptPerComputerForTests();
  const registry = AtomRegistry.make();
  const stop = followKeptPerComputerCatalog(registry);
  const read = new Map<string, unknown>();
  function Status(props: {
    readonly computer: string;
    readonly bot: string;
    readonly online: boolean;
  }) {
    const data = props.online ? answerFor(props.computer + "/" + props.bot) : null;
    read.set(
      props.computer + "/" + props.bot,
      useKeptPerComputer(
        "status",
        EnvironmentId.make(props.computer),
        {
          data,
          successResult: null,
          cause: null,
          error: null,
          isPending: false,
          isSuccess: data !== null,
          refresh: () => {},
        },
        props.bot,
      ),
    );
    return null;
  }
  const root = createRoot(document.createElement("div"));
  // Written one at a time, so the order they were kept in is the order given.
  for (let index = 1; index <= bots.length; index += 1)
    await act(async () =>
      root.render(
        <RegistryContext value={registry}>
          {bots.slice(0, index).map(([computer, bot]) => (
            <Status key={computer + bot} computer={computer} bot={bot} online />
          ))}
        </RegistryContext>,
      ),
    );
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        {bots.map(([computer, bot]) => (
          <Status key={computer + bot} computer={computer} bot={bot} online={false} />
        ))}
      </RegistryContext>,
    ),
  );
  await act(async () => root.unmount());
  stop();
  return read;
}

it("keeps at most 100 member statuses per computer, dropping the one kept longest ago", async () => {
  const bots = Array.from({ length: 101 }, (_, index) => ["env1", "bot" + index] as const);
  const kept = await keptAfterWriting(bots);
  expect(kept.get("env1/bot0")).toBeNull();
  expect(kept.get("env1/bot1")).not.toBeNull();
  expect(kept.get("env1/bot100")).not.toBeNull();
});

it("keeps at most 400 member statuses across computers, dropping the one kept longest ago", async () => {
  const bots = computers.flatMap((computer) =>
    Array.from({ length: 81 }, (_, index) => [computer, "bot" + index] as const),
  );
  const kept = await keptAfterWriting(bots);
  // 405 written: the first five are gone, the rest stay.
  expect(kept.get("env1/bot4")).toBeNull();
  expect(kept.get("env1/bot5")).not.toBeNull();
  expect(kept.get("env5/bot80")).not.toBeNull();
});
