import { ChannelTaskId, EnvironmentId, type ServerConfig } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createChannelEnvironmentAtoms } from "./channels.ts";

const calls = vi.hoisted(() => ({ count: 0 }));
const config = Atom.make<ServerConfig | null>(null);
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ initialConfigValueAtom: () => config }),
}));
vi.mock("./runtime.ts", () => ({
  createEnvironmentRpcCommand: () => ({}),
  createEnvironmentRpcSubscriptionAtomFamily: () => () => Atom.make(null),
  createEnvironmentSubscriptionAtomFamily: () => () => Atom.make(null),
  createEnvironmentRpcQueryAtomFamily: () => () =>
    Atom.make(() => {
      calls.count++;
      return AsyncResult.success({ groups: [{ taskId: "requested" }] });
    }),
}));

it("requests child work only while the environment advertises support", () => {
  calls.count = 0;
  const registry = AtomRegistry.make();
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  const atoms = createChannelEnvironmentAtoms(runtime);
  const query = atoms.listChildWork({
    environmentId: EnvironmentId.make("bot"),
    input: { taskIds: [ChannelTaskId.make("task")] },
  });
  registry.mount(query);
  expect(registry.get(query)).toMatchObject({ _tag: "Success", value: { groups: [] } });
  expect(calls.count).toBe(0);
  registry.set(config, {
    environment: { capabilities: { goatBotChildWork: true } },
  } as ServerConfig);
  expect(registry.get(query)).toMatchObject({
    _tag: "Success",
    value: { groups: [{ taskId: "requested" }] },
  });
  expect(calls.count).toBe(1);
  registry.set(config, { environment: { capabilities: {} } } as ServerConfig);
  expect(registry.get(query)).toMatchObject({ _tag: "Success", value: { groups: [] } });
  expect(calls.count).toBe(1);
  registry.dispose();
});
