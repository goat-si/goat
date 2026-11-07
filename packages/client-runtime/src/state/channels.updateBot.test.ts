import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

// The server's stored bot list, read each time the query runs.
const server = vi.hoisted(() => ({ name: "GOAT Bot", reads: 0 }));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => Atom.make(null) }),
}));
vi.mock("./runtime.ts", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: unknown) => ({ options }),
  createEnvironmentRpcSubscriptionAtomFamily: () => () => Atom.make(null),
  createEnvironmentRpcQueryAtomFamily: () => {
    const family = Atom.family((_key: string) =>
      Atom.make(() => {
        server.reads++;
        return AsyncResult.success({ bots: [{ botId: "main", role: "main", name: server.name }] });
      }),
    );
    return (target: unknown) => family(JSON.stringify(target));
  },
}));

it.effect("shows a saved bot name in the list the settings row reads", () =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make();
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
    );
    const atoms = createChannelEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("bot-home");
    const list = atoms.listBots({ environmentId, input: {} });
    registry.mount(list);
    expect(registry.get(list)).toMatchObject({ value: { bots: [{ name: "GOAT Bot" }] } });
    const { onSuccess } = (
      atoms.updateBot as unknown as {
        options: {
          onSuccess: (
            target: { environmentId: EnvironmentId; input: unknown },
            registry: AtomRegistry.AtomRegistry,
          ) => Effect.Effect<void>;
        };
      }
    ).options;
    server.name = "Jarvis";
    yield* onSuccess({ environmentId, input: { botId: "main", name: "Jarvis" } }, registry);
    expect(registry.get(list)).toMatchObject({ value: { bots: [{ name: "Jarvis" }] } });
    expect(server.reads).toBe(2);
    registry.dispose();
  }),
);
