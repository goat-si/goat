import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:settings");
const threadId = ThreadId.make("thread:settings");

const threadScope: McpInvocationContext.McpInvocationScope = {
  environmentId,
  requestNamespace: "provider:settings",
  thread: {
    threadId,
    providerSessionId: "provider:settings",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

const clientScope = (
  grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
  reauthorize: McpInvocationContext.McpInvocationScope["reauthorize"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "client:settings",
  thread: undefined,
  client: { sessionId: "client:settings", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration" as const]),
  grantedScopes,
  ...(reauthorize === undefined ? {} : { reauthorize }),
  issuedAt: 0,
});

/** Runs a tool against real settings persistence and returns its result and the stored settings. */
const call = (scope: McpInvocationContext.McpInvocationScope, name: string, args: unknown) =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const results = yield* toolkit
      .handle(name as "goat_environment_settings_update", args as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    const settings = yield* (yield* Settings.ServerSettingsService).getSettings;
    return { result: results.at(-1)?.result as Record<string, unknown>, settings };
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            ThreadCommandExecutor.layer,
            Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
            }),
            Layer.mock(Environment.ServerEnvironment)({
              getDescriptor: Effect.succeed({
                environmentId,
                label: "Test",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0",
                capabilities: { repositoryIdentity: false },
              }),
            }),
            Settings.layerTest(),
          ),
        ),
      ),
    ),
  );

it.effect("changes agent settings through the normal settings service", () =>
  Effect.gen(function* () {
    const { result, settings } = yield* call(threadScope, "goat_environment_settings_update", {
      patch: { branchNamePrefix: "goat/", automaticGitFetchInterval: 120_000 },
    });
    expect(settings.branchNamePrefix).toBe("goat/");
    expect(result).toEqual({
      settings: [
        { key: "branchNamePrefix", access: "agent", value: "goat/" },
        { key: "automaticGitFetchInterval", access: "agent", value: 120_000 },
      ],
    });
  }),
);

it.effect("writes nothing when any key belongs to a person or another path", () =>
  Effect.gen(function* () {
    const person = yield* call(threadScope, "goat_environment_settings_update", {
      patch: { branchNamePrefix: "goat/", defaultRuntimeMode: "full-access" },
    });
    expect(person.result).toMatchObject({ code: "capability_denied" });
    expect(String(person.result.message)).toContain(
      "defaultRuntimeMode is changed only by a person",
    );
    expect(person.settings.branchNamePrefix).not.toBe("goat/");

    const owned = yield* call(threadScope, "goat_environment_settings_update", {
      patch: { providerInstances: {} },
    });
    expect(owned.result).toMatchObject({ code: "invalid_request" });
    expect(String(owned.result.message)).toContain("provider.update");

    const unknown = yield* call(threadScope, "goat_environment_settings_update", {
      patch: { notASetting: true },
    });
    expect(unknown.result).toMatchObject({ code: "invalid_request" });

    const invalid = yield* call(threadScope, "goat_environment_settings_update", {
      patch: { branchNamePrefix: "goat/", reviewGuidesEnabled: "yes" },
    });
    expect(invalid.result).toMatchObject({ code: "invalid_request" });
    expect(invalid.settings.branchNamePrefix).not.toBe("goat/");
  }),
);

it.effect("holds an outside client to its live settings:write grant through the commit", () =>
  Effect.gen(function* () {
    const ungranted = yield* call(
      clientScope(["orchestration:operate"], () => Effect.void),
      "goat_environment_settings_update",
      { patch: { branchNamePrefix: "goat/" } },
    );
    expect(ungranted.result).toMatchObject({ code: "capability_denied" });

    // Admission passes; the session is revoked before the write commits.
    const checks = yield* Ref.make(0);
    const revokedAtCommit = yield* call(
      clientScope(["settings:write"], () =>
        Ref.getAndUpdate(checks, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0
              ? Effect.void
              : Effect.fail(
                  new EnvironmentAuthorizationError({
                    message: "The session was revoked.",
                    requiredScope: "settings:write",
                  }),
                ),
          ),
        ),
      ),
      "goat_environment_settings_update",
      { patch: { branchNamePrefix: "goat/" } },
    );
    expect(revokedAtCommit.result).toMatchObject({ code: "capability_denied" });
    expect(revokedAtCommit.settings.branchNamePrefix).not.toBe("goat/");

    const granted = yield* call(
      clientScope(["settings:write"], () => Effect.void),
      "goat_environment_settings_update",
      { patch: { branchNamePrefix: "goat/" } },
    );
    expect(granted.settings.branchNamePrefix).toBe("goat/");
  }),
);

it.effect("lists every setting with its access and shows values only agents may change", () =>
  Effect.gen(function* () {
    const all = yield* call(threadScope, "goat_environment_settings_read", {});
    const entries = all.result.settings as ReadonlyArray<Record<string, unknown>>;
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("completionWebhook")).toEqual({
      key: "completionWebhook",
      access: "person",
      reason: expect.any(String),
    });
    expect(byKey.get("providerInstances")).toEqual({
      key: "providerInstances",
      access: "path",
      path: "provider.update",
    });
    expect(byKey.get("branchNamePrefix")).toMatchObject({
      access: "agent",
      value: expect.any(String),
    });
    expect(entries.every((entry) => entry.schema === undefined)).toBe(true);

    const one = yield* call(threadScope, "goat_environment_settings_read", {
      keys: ["reviewGuidesEnabled"],
    });
    expect(one.result).toEqual({
      settings: [
        {
          key: "reviewGuidesEnabled",
          access: "agent",
          value: expect.any(Boolean),
          schema: { type: "boolean" },
        },
      ],
    });
  }),
);
