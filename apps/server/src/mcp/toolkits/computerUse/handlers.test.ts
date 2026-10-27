import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CuaDriver from "../../../cua/CuaDriver.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  serveCatalogOverHttp,
  serveCatalogOverHttpWithSettings,
} from "../../agentSurface.testkit.ts";

const client: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:settings",
  thread: undefined,
  client: { sessionId: "settings", label: "Settings client", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  grantedScopes: ["settings:write"],
  reauthorize: () => Effect.void,
};
const thread: McpInvocationScope = {
  ...client,
  client: undefined,
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => result.content.map((item) => item.text ?? "").join("");

it.effect("lists computer-use settings only to outside clients", () =>
  Effect.gen(function* () {
    const http = yield* serveCatalogOverHttp({ client, thread });
    expect((yield* http.listTools("client")).map((tool) => tool.name)).toContain(
      "goat_computer_use_update",
    );
    expect((yield* http.listTools("thread")).map((tool) => tool.name)).not.toContain(
      "goat_computer_use_update",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses thread, read-only, missing-scope, and revoked clients", () =>
  Effect.gen(function* () {
    const denied = {
      thread,
      readOnly: { ...client, client: { ...client.client!, access: "read-only" as const } },
      missing: { ...client, grantedScopes: [] },
      revoked: {
        ...client,
        reauthorize: () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: "session revoked",
              requiredScope: "settings:write",
            }),
          ),
      },
    };
    const http = yield* serveCatalogOverHttp(denied);
    for (const caller of Object.keys(denied)) {
      const result = yield* http.callTool(caller, "goat_computer_use_update", { enabled: true });
      expect(textOf(result), caller).toContain("capability_denied");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("an authorized outside client enables after admission and can disable", () =>
  Effect.gen(function* () {
    const admissions = yield* Ref.make(0);
    const settings = yield* ServerSettings.ServerSettingsService;
    const driver = Layer.mock(CuaDriver.CuaDriver)({
      admitEnable: Ref.update(admissions, (count) => count + 1),
    });
    const http = yield* serveCatalogOverHttpWithSettings(
      { client },
      Layer.succeed(ServerSettings.ServerSettingsService, settings),
    ).pipe(Effect.provide(driver));
    expect(
      textOf(yield* http.callTool("client", "goat_computer_use_update", { enabled: true })),
    ).toContain('"enabled":true');
    expect(yield* Ref.get(admissions)).toBe(1);
    expect((yield* settings.getSettings).enableCua).toBe(true);
    expect(
      textOf(yield* http.callTool("client", "goat_computer_use_update", { enabled: false })),
    ).toContain('"enabled":false');
    expect((yield* settings.getSettings).enableCua).toBe(false);
  }).pipe(
    Effect.provide(ServerSettings.layerTest()),
    Effect.scoped,
    Effect.provide(NodeHttpServer.layerTest),
  ),
);

it.effect("a failed admission returns its reason and leaves computer use off", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const driver = Layer.mock(CuaDriver.CuaDriver)({
      admitEnable: Effect.fail(
        new CuaDriver.CuaDriverHostError({ operation: "display", cause: "No desktop session." }),
      ),
    });
    const http = yield* serveCatalogOverHttpWithSettings(
      { client },
      Layer.succeed(ServerSettings.ServerSettingsService, settings),
    ).pipe(Effect.provide(driver));
    const result = yield* http.callTool("client", "goat_computer_use_update", { enabled: true });
    expect(textOf(result)).toContain("No desktop session.");
    expect((yield* settings.getSettings).enableCua).toBe(false);
  }).pipe(
    Effect.provide(ServerSettings.layerTest()),
    Effect.scoped,
    Effect.provide(NodeHttpServer.layerTest),
  ),
);
