import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createAuthEnvironmentAtoms } from "./auth.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthAccessWriteScope] : [],
  permissions: allowed ? [AuthAccessWriteScope] : [],
});

describe("saved environment access commands", () => {
  it.effect("dispatches each mutation to its target and rechecks that target's access grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = EnvironmentId.make("first");
        const selected = EnvironmentId.make("selected");
        const calls: Array<{ environment: EnvironmentId; method: string }> = [];
        const supervisorFor = Effect.fn("test.supervisor")(function* (environment: EnvironmentId) {
          const client = {
            [WS_METHODS.authAccessCreatePairing]: () =>
              Effect.sync(() => {
                calls.push({ environment, method: "create" });
                return {
                  id: "link",
                  credential: "test-code",
                  expiresAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z"),
                };
              }),
            [WS_METHODS.authAccessRevokePairing]: () =>
              Effect.sync(() => {
                calls.push({ environment, method: "pair" });
                return { revoked: true };
              }),
            [WS_METHODS.authAccessRevokeClient]: () =>
              Effect.sync(() => {
                calls.push({ environment, method: "client" });
                return { revoked: true };
              }),
          };
          return {
            target: { environmentId: environment, label: environment },
            session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
          } as unknown as EnvironmentSupervisor["Service"];
        });
        const firstSupervisor = yield* supervisorFor(first);
        const selectedSupervisor = yield* supervisorFor(selected);
        const runtime = Atom.runtime(
          Layer.succeed(EnvironmentRegistry, {
            run: (id: EnvironmentId, effect: Effect.Effect<unknown>) =>
              effect.pipe(
                Effect.provideService(
                  EnvironmentSupervisor,
                  id === first ? firstSupervisor : selectedSupervisor,
                ),
              ),
          } as unknown as EnvironmentRegistry["Service"]),
        );
        const commands = createAuthEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        registry.mount(sessions(first));
        registry.mount(sessions(selected));
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        registry.set(sessions(first), AsyncResult.success(grant(false)));
        registry.set(sessions(selected), AsyncResult.success(grant(true)));
        yield* Effect.promise(async () => {
          expect(
            (
              await commands.createPairing.run(registry, {
                environmentId: selected,
                input: { scopes: ["orchestration:read"] },
              })
            )._tag,
          ).toBe("Success");
          expect(
            (
              await commands.revokePairing.run(registry, {
                environmentId: selected,
                input: { id: "link" },
              })
            )._tag,
          ).toBe("Success");
          expect(
            (
              await commands.revokeClient.run(registry, {
                environmentId: selected,
                input: { sessionId: AuthSessionId.make("client") },
              })
            )._tag,
          ).toBe("Success");
          registry.set(
            sessions(selected),
            AsyncResult.success({ ...grant(true), proxiedByHub: true }),
          );
          expect(registry.get(commands.createPairing.permissionAtom(selected))).toBe(false);
          expect(
            (
              await commands.createPairing.run(registry, {
                environmentId: selected,
                input: { scopes: ["orchestration:read"] },
              })
            )._tag,
          ).toBe("Failure");
          registry.set(sessions(selected), AsyncResult.success(grant(false)));
          expect(
            (
              await commands.revokeClient.run(registry, {
                environmentId: selected,
                input: { sessionId: AuthSessionId.make("client") },
              })
            )._tag,
          ).toBe("Failure");
        });
        expect(calls).toEqual([
          { environment: selected, method: "create" },
          { environment: selected, method: "pair" },
          { environment: selected, method: "client" },
        ]);
      }),
    ),
  );
});
