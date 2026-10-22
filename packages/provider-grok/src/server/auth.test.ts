import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSetupError,
  redactProviderAuthState,
  type ProviderAuthState,
  type ServerProvider,
} from "@goat/contracts";
import type { ProviderAuthController } from "@goat/provider-core/server/auth";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  applyStoredGrokApiKey,
  GROK_API_KEY_ENV,
  GROK_CREDENTIAL_NAMESPACE,
  makeGrokAuth,
  resolveGrokLaunchEnvironment,
  withGrokAuthPresentation,
} from "./auth.ts";

const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const instanceId = ProviderInstanceId.make("grok-personal");
const emptyId = ProviderInstanceId.make("grok-empty");
const envId = ProviderInstanceId.make("grok-env");
const otherId = ProviderInstanceId.make("grok-work");
const secret = "grok-test-api-key";
const owner = "owner-client";

const phase = (controller: ProviderAuthController, name: ProviderAuthState["phase"]) =>
  controller.subscribe(owner).pipe(
    Stream.filter((state) => state.phase === name),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const storedBytes = (id: ProviderInstanceId) =>
  Effect.gen(function* () {
    const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
      GROK_CREDENTIAL_NAMESPACE,
      id,
    );
    return yield* credentials.get;
  });

it("keeps an existing XAI_API_KEY and fills one only when it is missing", () => {
  expect(applyStoredGrokApiKey({ [GROK_API_KEY_ENV]: "env-key" }, secret)[GROK_API_KEY_ENV]).toBe(
    "env-key",
  );
  expect(applyStoredGrokApiKey({ [GROK_API_KEY_ENV]: "  " }, secret)[GROK_API_KEY_ENV]).toBe(
    secret,
  );
  expect(applyStoredGrokApiKey({}, undefined)[GROK_API_KEY_ENV]).toBeUndefined();
});

it("offers sign-out only for a stored key, and in-app sign-in when no env key is set", () => {
  const snapshot = {
    auth: { status: "authenticated" as const, type: "api_key", label: "xAI API key" },
  } as ServerProvider;
  expect(
    withGrokAuthPresentation(snapshot, {
      enabled: true,
      hasEnvironmentKey: false,
      hasStoredKey: true,
    }),
  ).toMatchObject({
    setup: { canAuthenticate: true, canInstall: false },
    auth: { canLogout: true, type: "api_key" },
  });
  expect(
    withGrokAuthPresentation(snapshot, {
      enabled: true,
      hasEnvironmentKey: true,
      hasStoredKey: false,
    }).setup?.canAuthenticate,
  ).toBe(false);
  expect(
    withGrokAuthPresentation(snapshot, {
      enabled: false,
      hasEnvironmentKey: false,
      hasStoredKey: false,
    }).auth.canLogout,
  ).toBe(false);
});

it.layer(layer)("GrokAuth", (it) => {
  it.effect("stores a per-instance API key and redacts it from sign-in state", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const auth = yield* makeGrokAuth({
        instanceId,
        enabled: true,
        hasEnvironmentKey: false,
        onChanged: () => Effect.void,
      });
      const started = yield* auth.controller.start(owner);
      const waiting = yield* phase(auth.controller, "waiting");
      expect(waiting.interaction).toEqual({
        type: "credentials",
        id: "api-key",
        fields: [{ name: "apiKey", label: "API key", secret: true }],
      });
      seen.push(JSON.stringify(waiting), JSON.stringify(redactProviderAuthState(waiting)));
      const poisoned = redactProviderAuthState({
        ...waiting,
        message: secret,
        authorizationUrl: `https://example.test/?key=${secret}`,
      });
      expect(poisoned.continueIn).toBe("app");
      expect(poisoned.deviceCode).toBeNull();
      expect(poisoned.message).toBe("Waiting for the person to finish signing in.");
      seen.push(JSON.stringify(poisoned));

      yield* auth.controller.respond!(owner, {
        instanceId,
        flowId: started.flowId!,
        interactionId: "api-key",
        response: { type: "credentials", values: { apiKey: secret } },
      });
      const succeeded = yield* phase(auth.controller, "succeeded");
      expect(succeeded.interaction).toBeNull();
      seen.push(JSON.stringify(succeeded), JSON.stringify(redactProviderAuthState(succeeded)));
      for (const published of seen) expect(published).not.toContain(secret);

      const stored = yield* storedBytes(instanceId);
      expect(Option.isSome(stored)).toBe(true);
      if (Option.isSome(stored)) expect(new TextDecoder().decode(stored.value)).toBe(secret);

      const personal = yield* resolveGrokLaunchEnvironment(instanceId, {});
      const work = yield* resolveGrokLaunchEnvironment(otherId, {});
      expect(personal[GROK_API_KEY_ENV]).toBe(secret);
      expect(work[GROK_API_KEY_ENV]).toBeUndefined();

      yield* auth.controller.logout(Effect.void);
      expect(Option.isNone(yield* storedBytes(instanceId))).toBe(true);
      expect((yield* resolveGrokLaunchEnvironment(instanceId, {}))[GROK_API_KEY_ENV]).toBe(
        undefined,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an empty key and drops a key that cannot be verified", () =>
    Effect.gen(function* () {
      const auth = yield* makeGrokAuth({
        instanceId: emptyId,
        enabled: true,
        hasEnvironmentKey: false,
        onChanged: (expectAuthenticated) =>
          expectAuthenticated
            ? Effect.fail(
                new ProviderSetupError({
                  instanceId: emptyId,
                  operation: "start",
                  detail: "Could not verify the Grok sign-in. Try again.",
                }),
              )
            : Effect.void,
      });
      const started = yield* auth.controller.start(owner);
      yield* phase(auth.controller, "waiting");
      const empty = yield* auth.controller.respond!(owner, {
        instanceId: emptyId,
        flowId: started.flowId!,
        interactionId: "api-key",
        response: { type: "credentials", values: { apiKey: "  " } },
      }).pipe(Effect.result);
      expect(empty._tag).toBe("Failure");
      expect(Option.isNone(yield* storedBytes(emptyId))).toBe(true);

      yield* auth.controller.respond!(owner, {
        instanceId: emptyId,
        flowId: started.flowId!,
        interactionId: "api-key",
        response: { type: "credentials", values: { apiKey: secret } },
      });
      const failed = yield* phase(auth.controller, "failed");
      expect(failed.message).toBe("Could not verify the Grok sign-in. Try again.");
      expect(JSON.stringify(failed)).not.toContain(secret);
      expect(JSON.stringify(redactProviderAuthState(failed))).not.toContain(secret);
      expect(Option.isNone(yield* storedBytes(emptyId))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses browser-style sign-in when XAI_API_KEY is already set", () =>
    Effect.gen(function* () {
      const auth = yield* makeGrokAuth({
        instanceId: envId,
        enabled: true,
        hasEnvironmentKey: true,
        onChanged: () => Effect.void,
      });
      yield* auth.controller.start(owner);
      const failed = yield* phase(auth.controller, "failed");
      expect(failed.message).toContain("XAI_API_KEY");
      expect(Option.isNone(yield* storedBytes(envId))).toBe(true);
      const loggedOut = yield* auth.controller.logout(Effect.void).pipe(Effect.result);
      expect(loggedOut._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});
