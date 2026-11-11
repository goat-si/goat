import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import type { PenPeer } from "../auth/connectionContext.ts";
import { MAIN_LISTENER, penConnection } from "../auth/connectionContext.testkit.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PenEnablement from "./PenEnablement.ts";
import { layerTest as layerEnablement } from "./PenEnablement.testkit.ts";
import * as PenSessionsModule from "./PenSessions.ts";
import { agentScopes, PEN_SESSION_LIMITS, PenSessions } from "./PenSessions.ts";

const peer = (nodeId = "node-a"): PenPeer => ({
  meshId: "mesh-1",
  nodeId,
  signPub: `sign-${nodeId}`,
  noisePub: `noise-${nodeId}`,
  name: nodeId,
});
const live = (nodeId = "node-a", generation = 1) =>
  penConnection(peer(nodeId), { generation }).context;
const agent = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "agent",
    access: "full-access",
    memory: "none",
    providersManage: false,
    settingsWrite: false,
    ...overrides,
  });

type Repository = AuthSessions.AuthSessionRepository["Service"];
const layerBase = SessionStore.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("pen-sessions-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-sessions-" })),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

/** The real store; PenSessions may see one repository operation replaced. */
const layerWith = (
  patch: (real: Repository) => Partial<Repository> = () => ({}),
  enabled: Layer.Layer<PenEnablement.PenEnablement> = layerEnablement(true),
) =>
  PenSessionsModule.layer.pipe(
    Layer.provide(
      Layer.effect(
        AuthSessions.AuthSessionRepository,
        Effect.map(AuthSessions.make, (real) => ({ ...real, ...patch(real) })),
      ),
    ),
    Layer.provide(enabled),
    Layer.provideMerge(layerBase),
  );

it.layer(NodeServices.layer)(
  "Pen member session issue (mesh link design §5, review P3-1)",
  (it) => {
    it.effect(
      "grants exactly what each dimension asks for and never approvals or Child setup",
      () =>
        Effect.gen(function* () {
          const pen = yield* PenSessions;
          const sessions = yield* SessionStore.SessionStore;
          yield* pen.setGeneration(1);
          for (const access of ["read-only", "approval-required", "auto", "full-access"] as const)
            for (const settingsWrite of [false, true])
              for (const providersManage of [false, true]) {
                const body = agent({ access, settingsWrite, providersManage, memory: "read" });
                const issued = yield* pen.issue(live(), body);
                const verified = yield* sessions.verify(issued.token, live());
                expect(verified.scopes.includes("settings:write")).toBe(settingsWrite);
                expect(verified.scopes.includes("providers:manage")).toBe(providersManage);
                expect(verified.scopes.includes("orchestration:approve")).toBe(false);
                expect(verified.scopes.includes("memory:read")).toBe(true);
                expect(verified.scopes.includes("memory:write")).toBe(false);
                expect(verified.childSetupPurpose).toBeUndefined();
                expect(verified.principalKind).toBe("outside_client");
                expect([...verified.scopes].toSorted()).toEqual(
                  [
                    ...agentScopes({
                      kind: "agent",
                      access,
                      memory: "read",
                      settingsWrite,
                      providersManage,
                    }),
                  ].toSorted(),
                );
                expect(yield* sessions.readActiveScopes(verified.sessionId)).toEqual(
                  verified.scopes,
                );
              }
          const proxy = yield* pen.issue(
            live(),
            JSON.stringify({ kind: "proxy", scopes: ["orchestration:read"] }),
          );
          expect(proxy.scopes).toEqual(["orchestration:read"]);
          expect((yield* sessions.verify(proxy.token, live())).principalKind).toBe(
            "proxied_person",
          );
          for (const body of [
            agent({ approvals: true }),
            agent({ childSetupPurpose: { kind: "x" } }),
            agent({ scopes: ["settings:write"] }),
            JSON.stringify({ kind: "proxy", scopes: ["orchestration:read", "settings:write"] }),
            JSON.stringify({ kind: "proxy", scopes: ["orchestration:approve"] }),
            JSON.stringify({ kind: "proxy", scopes: [] }),
            JSON.stringify({ kind: "person" }),
            "not json",
            agent({ label: "x".repeat(PEN_SESSION_LIMITS.bodyBytes) }),
          ])
            expect((yield* Effect.flip(pen.issue(live(), body))).code, body.slice(0, 80)).toBe(
              "refused",
            );
        }).pipe(Effect.provide(layerWith())),
    );

    it.effect(
      "caps active member sessions at 64 each and 512 in all, cleaning expired ones first",
      () =>
        Effect.gen(function* () {
          const pen = yield* PenSessions;
          const sessions = yield* SessionStore.SessionStore;
          yield* pen.setGeneration(1);
          const person = yield* sessions.issue({ subject: "browser" });
          for (let index = 0; index < PEN_SESSION_LIMITS.perMember; index += 1)
            yield* pen.issue(live(), agent());
          expect((yield* Effect.flip(pen.issue(live(), agent()))).code).toBe("overloaded");
          for (
            let node = 1;
            node < PEN_SESSION_LIMITS.total / PEN_SESSION_LIMITS.perMember;
            node += 1
          )
            for (let index = 0; index < PEN_SESSION_LIMITS.perMember; index += 1)
              yield* pen.issue(live(`node-${node}`), agent());
          expect((yield* Effect.flip(pen.issue(live("node-new"), agent()))).code).toBe(
            "overloaded",
          );
          // Every member session lives at most 12 hours; once expired, cleanup makes room.
          yield* TestClock.adjust("12 hours");
          yield* pen.issue(live("node-new"), agent());
          expect((yield* sessions.verify(person.token, MAIN_LISTENER)).subject).toBe("browser");
        }).pipe(Effect.provide(layerWith())),
    );

    it.effect(
      "refuses a fifth concurrent issue at once; finished and interrupted issues free their permits",
      () =>
        Effect.gen(function* () {
          const gate = yield* Deferred.make<void>();
          const entered = yield* Deferred.make<void>();
          let holding = true;
          yield* Effect.gen(function* () {
            const pen = yield* PenSessions;
            yield* pen.setGeneration(1);
            const holdAll = Effect.forEach(
              Array.from({ length: PEN_SESSION_LIMITS.concurrentIssues }),
              () => pen.issue(live(), agent()).pipe(Effect.forkScoped({ startImmediately: true })),
            );
            const interrupted = yield* holdAll;
            yield* Deferred.await(entered);
            expect((yield* Effect.flip(pen.issue(live(), agent()))).code).toBe("overloaded");
            yield* Effect.forEach(interrupted, Fiber.interrupt);
            holding = false;
            const finished = yield* holdAll;
            for (const fiber of finished) yield* Fiber.join(fiber);
            yield* pen.issue(live(), agent());
          }).pipe(
            Effect.provide(
              layerWith((real) => ({
                deleteInactivePenBound: (input) =>
                  holding
                    ? Deferred.succeed(entered, undefined).pipe(
                        Effect.andThen(Deferred.await(gate)),
                        Effect.andThen(real.deleteInactivePenBound(input)),
                      )
                    : real.deleteInactivePenBound(input),
              })),
            ),
          );
        }).pipe(Effect.scoped),
    );

    it.effect("answers unavailable on a storage failure and revokes nothing else", () =>
      Effect.gen(function* () {
        const pen = yield* PenSessions;
        const sessions = yield* SessionStore.SessionStore;
        yield* pen.setGeneration(1);
        const person = yield* sessions.issue({ subject: "browser" });
        expect((yield* Effect.flip(pen.issue(live(), agent()))).code).toBe("unavailable");
        expect((yield* sessions.verify(person.token, MAIN_LISTENER)).subject).toBe("browser");
      }).pipe(
        Effect.provide(
          layerWith(() => ({
            countActivePenBound: () =>
              Effect.fail(new PersistenceSqlError({ operation: "count", detail: "disk gone" })),
          })),
        ),
      ),
    );

    it.effect(
      "issues only on a live connection of the current generation; revokes members who left",
      () =>
        Effect.gen(function* () {
          const pen = yield* PenSessions;
          const sessions = yield* SessionStore.SessionStore;
          yield* pen.setGeneration(2);
          expect((yield* Effect.flip(pen.issue(live("node-a", 1), agent()))).code).toBe("refused");
          const closed = penConnection(peer(), { generation: 2 });
          closed.close();
          expect((yield* Effect.flip(pen.issue(closed.context, agent()))).code).toBe("refused");
          const a = yield* pen.issue(live("node-a", 2), agent());
          const b = yield* pen.issue(live("node-b", 2), agent());
          const person = yield* sessions.issue({ subject: "browser" });
          expect(yield* pen.revokeExcept([peer("node-b")])).toBe(1);
          expect(
            Exit.isFailure(yield* Effect.exit(sessions.verify(a.token, live("node-a", 2)))),
          ).toBe(true);
          expect(
            Exit.isSuccess(yield* Effect.exit(sessions.verify(b.token, live("node-b", 2)))),
          ).toBe(true);
          // A member whose key changed is a different member.
          expect(yield* pen.revokeExcept([{ ...peer("node-b"), noisePub: "noise-rotated" }])).toBe(
            1,
          );
          expect(
            Exit.isFailure(yield* Effect.exit(sessions.verify(b.token, live("node-b", 2)))),
          ).toBe(true);
          expect((yield* sessions.verify(person.token, MAIN_LISTENER)).subject).toBe("browser");
        }).pipe(Effect.provide(layerWith())),
    );

    it.effect("the build's closed gate refuses every issue", () =>
      Effect.gen(function* () {
        const pen = yield* PenSessions;
        yield* pen.setGeneration(1);
        expect(PenEnablement.PEN_TARGET_ENABLED).toBe(false);
        expect((yield* Effect.flip(pen.issue(live(), agent()))).code).toBe("refused");
      }).pipe(Effect.provide(layerWith(undefined, PenEnablement.layer))),
    );
  },
);
