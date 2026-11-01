import { describe, expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  HubProxyRpcError,
  WS_METHODS,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type HubNodesSnapshot,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createHubProxyEnvironmentAtoms } from "./hubProxy.ts";
import { squashAtomCommandFailure } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const hub = EnvironmentId.make("hub");
const other = EnvironmentId.make("other");
const fixture = Effect.fn(function* (options?: { readonly failEnroll?: boolean }) {
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.mount(sessions(hub));
  registry.mount(sessions(other));
  const calls: { method: string; input: unknown }[] = [];
  const snapshots = yield* SubscriptionRef.make<HubNodesSnapshot>({
    hubEnvironmentId: hub,
    nodes: [],
    notices: [],
  });
  const session = {
    client: {
      [WS_METHODS.hubNodesSubscribe]: () => SubscriptionRef.changes(snapshots),
      [WS_METHODS.hubProxyPrepareNode]: (input: unknown) =>
        Effect.sync(() => {
          calls.push({ method: WS_METHODS.hubProxyPrepareNode, input });
          return {};
        }),
      [WS_METHODS.hubProxyEnrollNode]: (input: unknown) =>
        Effect.gen(function* () {
          calls.push({ method: WS_METHODS.hubProxyEnrollNode, input });
          if (options?.failEnroll)
            return yield* Effect.fail(
              new HubProxyRpcError({
                reason: "refused",
                detail: "Use a pairing link from this machine.",
              }),
            );
          return { scopes: [AuthOrchestrationReadScope] };
        }),
      [WS_METHODS.hubProxyUnenrollNode]: (input: unknown) =>
        Effect.sync(() => {
          calls.push({ method: WS_METHODS.hubProxyUnenrollNode, input });
          return { removed: true };
        }),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: hub, label: "Hub" },
    session: yield* SubscriptionRef.make(Option.some(session)),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (id: EnvironmentId, effect: Effect.Effect<unknown>) =>
        effect.pipe(
          Effect.provideService(EnvironmentSupervisor, {
            ...supervisor,
            target: { ...supervisor.target, environmentId: id },
          }),
        ),
      followStream: (
        _id: EnvironmentId,
        stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
      ) => stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const commands = createHubProxyEnvironmentAtoms(runtime);
  const grant = (id: EnvironmentId, scopes: readonly AuthEnvironmentScope[]) =>
    registry.set(
      sessions(id),
      AsyncResult.success({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes,
        permissions: scopes,
      }),
    );
  return { registry, commands, grant, calls, snapshots };
});

describe("hub proxy environment atoms", () => {
  it.effect("requires the destination settings grant for setup, enrollment, and removal", () =>
    Effect.gen(function* () {
      const h = yield* fixture();
      const input = { nodeId: "box", pairingUrl: "https://box.test/pair?code=once" };
      h.grant(hub, [AuthSettingsWriteScope]);
      h.grant(other, [AuthOrchestrationReadScope]);
      for (const command of [
        h.commands.prepareNode,
        h.commands.enrollNode,
        h.commands.unenrollNode,
      ]) {
        expect(h.registry.get(command.permissionAtom(hub))).toBe(true);
        expect(h.registry.get(command.permissionAtom(other))).toBe(false);
        expect(
          (yield* Effect.promise(() => command.run(h.registry, { environmentId: other, input })))
            ._tag,
        ).toBe("Failure");
      }
      expect(h.calls).toEqual([]);
      expect(
        (yield* Effect.promise(() =>
          h.commands.prepareNode.run(h.registry, { environmentId: hub, input: { nodeId: "box" } }),
        ))._tag,
      ).toBe("Success");
      const enrolled = yield* Effect.promise(() =>
        h.commands.enrollNode.run(h.registry, { environmentId: hub, input }),
      );
      expect(enrolled).toMatchObject({
        _tag: "Success",
        value: { scopes: [AuthOrchestrationReadScope] },
      });
      expect(
        (yield* Effect.promise(() =>
          h.commands.unenrollNode.run(h.registry, { environmentId: hub, input: { nodeId: "box" } }),
        ))._tag,
      ).toBe("Success");
      expect(h.calls).toEqual([
        { method: WS_METHODS.hubProxyPrepareNode, input: { nodeId: "box" } },
        { method: WS_METHODS.hubProxyEnrollNode, input },
        { method: WS_METHODS.hubProxyUnenrollNode, input: { nodeId: "box" } },
      ]);
      h.grant(hub, []);
      expect(h.registry.get(h.commands.enrollNode.permissionAtom(hub))).toBe(false);
      expect(
        (yield* Effect.promise(() =>
          h.commands.enrollNode.run(h.registry, { environmentId: hub, input }),
        ))._tag,
      ).toBe("Failure");
      expect(h.calls).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves the server's enrollment failure detail", () =>
    Effect.gen(function* () {
      const h = yield* fixture({ failEnroll: true });
      h.grant(hub, [AuthSettingsWriteScope]);
      const result = yield* Effect.promise(() =>
        h.commands.enrollNode.run(h.registry, {
          environmentId: hub,
          input: { nodeId: "box", pairingUrl: "https://box.test/pair?code=once" },
        }),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(squashAtomCommandFailure(result)).toMatchObject({
          detail: "Use a pairing link from this machine.",
        });
    }).pipe(Effect.scoped),
  );
});
