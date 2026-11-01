import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Settings from "../serverSettings.ts";
import * as Config from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Routes from "./CodexRouteService.ts";
export const instanceId = ProviderInstanceId.make("codex-home-test");
export const environmentId = EnvironmentId.make("home-test-host");
export const sessionId = AuthSessionId.make("human-home-reviewer");
export const caller = { kind: "client" as const, sessionId };
export const session = (now: DateTime.Utc): AuthClientSession => ({
  sessionId,
  subject: "test",
  method: "browser-session-cookie",
  scopes: ["orchestration:operate", "providers:manage"],
  permissions: ["orchestration:operate", "providers:manage"],
  client: { label: "Test human", deviceType: "unknown" },
  issuedAt: now,
  expiresAt: DateTime.add(now, { days: 1 }),
  lastConnectedAt: now,
  connected: true,
  current: true,
});
export const layer = Routes.layer.pipe(
  Layer.provideMerge(
    Settings.layer.pipe(
      Layer.provide(Secrets.layer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "codex-route-service-" })),
    ),
  ),
  Layer.provide(
    Layer.mock(Sessions.SessionStore)({
      cookieName: "test",
      legacyCookieName: undefined,
      listActive: () => DateTime.now.pipe(Effect.map((now) => [session(now)])),
    }),
  ),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Routes.layerState),
  Layer.provideMerge(NodeServices.layer),
);
/** Await the actual persisted revision, acknowledge it, then observe the caller's result. */
export const commitAndApply = <A, E, R>(mutation: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const state = yield* Routes.CodexRouteState;
      const changes = yield* settings.subscribeProviderChanges!;
      const baseline = state.revision();
      const fiber = yield* mutation.pipe(Effect.forkScoped);
      const event = yield* Stream.runHead(
        changes.pipe(
          Stream.filter(
            (event) =>
              event.revision.epoch === baseline.epoch &&
              event.revision.sequence > baseline.sequence,
          ),
        ),
      );
      if (Option.isNone(event)) return yield* Effect.die("Expected a committed revision");
      yield* state.applied(event.value.revision);
      return yield* Fiber.join(fiber);
    }),
  );
