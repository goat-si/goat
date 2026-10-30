import { EnvironmentId, type AuthSessionState, type ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { createMemoryEnvironmentAtoms } from "./memory.ts";

vi.mock("./connections.ts", () => ({
  createEnvironmentCatalogAtoms: () => ({
    catalogValueAtom: Atom.make({ entries: new Map([[env, { enabled: true }]]) }),
  }),
}));
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: grants,
    initialConfigValueAtom: configs,
    preparedConnectionValueAtom: prepared,
  }),
}));
const grants = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const configs = Atom.family((_id: EnvironmentId) => Atom.make<ServerConfig | null>(null));
const prepared = Atom.family((_id: EnvironmentId) =>
  Atom.make(Option.some({} as PreparedConnection)),
);
const env = EnvironmentId.make("selected-tunnel");
const harness = Effect.fn(function* () {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {} as EnvironmentRegistry["Service"]),
  );
  const memory = createMemoryEnvironmentAtoms(runtime);
  registry.mount(grants(env));
  registry.mount(configs(env));
  registry.mount(prepared(env));
  registry.set(
    grants(env),
    AsyncResult.success({
      authenticated: true,
      scopes: ["memory:read", "memory:write"],
      permissions: ["memory:read", "memory:write"],
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "synthetic",
      },
    }),
  );
  return { registry, memory };
});

it.effect("gates site notes permissions on the selected environment capability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      for (const supported of [undefined, false, true] as const) {
        h.registry.set(configs(env), {
          environment: { capabilities: { memory: { protocolVersion: 1, siteNotes: supported } } },
        } as ServerConfig);
        expect(h.registry.get(h.memory.siteNotesList.permissionAtom(env))).toBe(supported === true);
        expect(h.registry.get(h.memory.siteNotesWrite.permissionAtom(env))).toBe(
          supported === true,
        );
      }
    }),
  ),
);
