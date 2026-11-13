import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SessionStore from "../../auth/SessionStore.ts";
import { UnknownSessionTokenError } from "../../auth/sessionStoreErrors.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { coversDelegation } from "./attachModel.ts";
import { Provisioners } from "./DisposableAttach.ts";
import * as DisposableProvisioners from "./DisposableProvisioners.ts";

const THREAD = { kind: "thread" as const, threadId: "t1" };
const PERSON = { kind: "person" as const, sessionId: "s1" };

/** What the hub knows now: the thread's projection, its goatclaw profile and the session's scopes. */
const live = () => ({
  thread: {
    id: "t1",
    archivedAt: null as string | null,
    deletedAt: null as string | null,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: "codex" },
  },
  goatclaw: {
    enabled: true,
    capabilities: ["hub.manage", "threads.launch"],
    hosts: undefined as ReadonlyArray<string> | undefined,
  },
  scopes: ["orchestration:read", "settings:write"] as ReadonlyArray<string> | undefined,
});

const provisioners = (now: ReturnType<typeof live>) =>
  DisposableProvisioners.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2, {
          getThreadProjection: () => Effect.sync(() => ({ thread: now.thread }) as never),
        }),
        Layer.mock(SessionStore.SessionStore, {
          cookieName: "test-session",
          legacyCookieName: undefined,
          readActiveScopes: (sessionId) =>
            now.scopes === undefined
              ? Effect.fail(new UnknownSessionTokenError({ sessionId }))
              : Effect.succeed(now.scopes as never),
        }),
        Layer.mock(Profiles.PermissionProfiles, {
          check: (_scope, capability, context) =>
            Effect.sync(() => {
              const effective = {
                enabled: now.goatclaw.enabled,
                runtimeMode: "full-access",
                profile: { capabilities: now.goatclaw.capabilities, hosts: now.goatclaw.hosts },
              } as never;
              const allowed =
                !now.goatclaw.enabled ||
                (now.goatclaw.capabilities.includes(capability) &&
                  (now.goatclaw.hosts === undefined ||
                    now.goatclaw.hosts.includes(context?.host ?? "")));
              return allowed ? { ok: true, effective } : { ok: false, reason: "refused" };
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment, {
          getDescriptor: Effect.succeed({ environmentId: "env-1" } as never),
        }),
      ),
    ),
  );

const grantOf = (provisioner: typeof THREAD | typeof PERSON) =>
  Effect.flatMap(Provisioners, (service) => service.grantOf(provisioner, "node1"));

it.effect(
  "a thread whose modes, profile or hosts narrowed no longer holds its recorded grant",
  () => {
    const now = live();
    return Effect.gen(function* () {
      const recorded = yield* grantOf(THREAD);
      expect(recorded).toEqual({
        kind: "thread",
        runtimeMode: "full-access",
        interactionMode: "default",
        goatclaw: {
          capabilities: ["hub.manage", "threads.launch"],
          runtimeMode: "full-access",
          hosts: null,
        },
      });
      expect(coversDelegation(yield* grantOf(THREAD), recorded)).toBe(true);
      now.goatclaw.capabilities = ["hub.manage"];
      expect(coversDelegation(yield* grantOf(THREAD), recorded)).toBe(false);
      now.goatclaw.capabilities = ["hub.manage", "threads.launch"];
      now.goatclaw.hosts = ["pen-node1"];
      expect(coversDelegation(yield* grantOf(THREAD), recorded)).toBe(false);
      now.goatclaw.hosts = ["pen-other"];
      expect(yield* grantOf(THREAD)).toBeUndefined();
      // goatclaw off applies no profile, so it covers one recorded while it was on.
      now.goatclaw.enabled = false;
      expect(coversDelegation(yield* grantOf(THREAD), recorded)).toBe(true);
      now.thread.interactionMode = "plan";
      expect(yield* grantOf(THREAD)).toBeUndefined();
      now.thread.interactionMode = "default";
      now.thread.archivedAt = "2026-11-13T00:00:00.000Z";
      expect(yield* grantOf(THREAD)).toBeUndefined();
    }).pipe(Effect.provide(provisioners(now)));
  },
);

it.effect("a person holds the grant while the session is active with every recorded scope", () => {
  const now = live();
  return Effect.gen(function* () {
    const recorded = yield* grantOf(PERSON);
    expect(recorded).toEqual({ kind: "person", scopes: ["orchestration:read", "settings:write"] });
    now.scopes = ["orchestration:read"];
    expect(coversDelegation(yield* grantOf(PERSON), recorded)).toBe(false);
    now.scopes = undefined;
    expect(yield* grantOf(PERSON)).toBeUndefined();
    expect(coversDelegation(recorded, yield* grantOf(THREAD))).toBe(false);
  }).pipe(Effect.provide(provisioners(now)));
});
