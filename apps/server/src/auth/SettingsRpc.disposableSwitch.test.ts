import { expect, it } from "@effect/vitest";
import type { ServerSettingsPatch } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { disposableSwitch, withPersonConsent } from "../hub/disposable/disposableSwitch.ts";
import * as Routes from "../provider/CodexRouteService.ts";
import * as ConnectRuntime from "./ConnectHubRuntime.testkit.ts";
import { MAIN_LISTENER } from "./connectionContext.testkit.ts";
import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";
import * as SettingsRpc from "./SettingsRpc.ts";

const turnOn: ServerSettingsPatch = { hub: { attachDisposableMachines: { enabled: true } } };

// The switch admits machines to the owner's Pen mesh: settings.write alone is not a person.
it.effect("only a person's session changes the disposable machines switch", () =>
  Effect.gen(function* () {
    const runtime = yield* ConnectRuntime.open();
    yield* runtime.settings.start;
    yield* runtime.settings.updateSettings({ hub: { enabled: true } });
    const session = (input: { readonly subject: string; readonly bearer: boolean }) =>
      runtime.sessions
        .issue({
          subject: input.subject,
          scopes: ["settings:write"],
          ...(input.bearer ? { method: "bearer-access-token" as const } : {}),
        })
        .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token, MAIN_LISTENER)));
    const outsideClient = yield* session({ subject: MCP_CLIENT_SUBJECT, bearer: true });
    const person = yield* session({ subject: "owner", bearer: false });
    const enabled = runtime.settings.getSettings.pipe(
      Effect.map((settings) => settings.hub.attachDisposableMachines.enabled),
    );
    yield* Effect.gen(function* () {
      const asClient = yield* SettingsRpc.make(outsideClient);
      expect(yield* asClient({ patch: turnOn }).pipe(Effect.isFailure)).toBe(true);
      expect(yield* enabled).toBe(false);
      // The same client still changes settings that are not the switch.
      yield* asClient({ patch: { hub: { cloudHolder: "auto" } } });
      expect((yield* runtime.settings.getSettings).hub.cloudHolder).toBe("auto");

      const asPerson = yield* SettingsRpc.make(person);
      expect(
        yield* asPerson({
          patch: turnOn,
          providerInstanceMutation: { operation: "remove", instanceId: "codex" as never },
        }).pipe(Effect.isFailure),
      ).toBe(true);
      expect(yield* enabled).toBe(false);
      yield* asPerson({ patch: turnOn });
      expect(yield* enabled).toBe(true);
    }).pipe(
      Effect.provide(Layer.mock(Routes.CodexRouteService)({})),
      Effect.provideContext(runtime.context),
    );
  }).pipe(Effect.scoped, Effect.provide(ConnectRuntime.storage)),
);

// hub needs only settings:write, so turning the hub off and on must not renew an expired switch.
it.effect("a client with settings:write cannot reopen an expired switch through the hub", () =>
  Effect.gen(function* () {
    const runtime = yield* ConnectRuntime.open();
    yield* runtime.settings.start;
    yield* withPersonConsent(
      runtime.settings.updateSettings({
        hub: { enabled: true, attachDisposableMachines: { enabled: true } },
      }),
    );
    const opened = (yield* runtime.settings.getSettings).hub.attachDisposableMachines;
    yield* TestClock.adjust(31 * 24 * 60 * 60 * 1000);
    const now = yield* Clock.currentTimeMillis;
    const client = yield* runtime.sessions
      .issue({
        subject: MCP_CLIENT_SUBJECT,
        scopes: ["settings:write"],
        method: "bearer-access-token",
      })
      .pipe(Effect.flatMap((issued) => runtime.sessions.verify(issued.token, MAIN_LISTENER)));
    yield* Effect.gen(function* () {
      const asClient = yield* SettingsRpc.make(client);
      yield* asClient({ patch: { hub: { enabled: false } } });
      yield* asClient({ patch: { hub: { enabled: true } } });
      const hub = (yield* runtime.settings.getSettings).hub;
      expect(disposableSwitch(hub, now).open).toBe(false);
      // Turning the hub off turned the switch off and cleared its expiry; nothing renewed it.
      expect(hub.attachDisposableMachines).toMatchObject({ enabled: false, expiresAt: null });
      expect(opened.enabled).toBe(true);
    }).pipe(
      Effect.provide(Layer.mock(Routes.CodexRouteService)({})),
      Effect.provideContext(runtime.context),
    );
  }).pipe(Effect.scoped, Effect.provide(ConnectRuntime.storage)),
);
