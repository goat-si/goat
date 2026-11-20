import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Atom } from "effect/reactivity";
import { EnvironmentId, type ServerSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../../../config.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as ThemePublication from "../../../themePublication.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const state = vi.hoisted(() => ({
  setTheme: vi.fn((choice: string) => {
    state.selected = choice;
    return true;
  }),
  appearanceMode: "dark",
  selected: "grove",
}));
vi.mock("../../../../../web/src/state/desktopHostEnvironment", () => ({
  themeEnvironmentIdAtom: Atom.make("env-agent-reset"),
}));
vi.mock("../../../../../web/src/state/server", () => ({
  themeServerSettingsAtom: Atom.make({
    defaultTheme: "",
    defaultThemeSetAt: "",
    defaultAppearance: "",
    defaultAppearanceSetAt: "",
  }),
}));
vi.mock("../../../../../web/src/themePalette", () => ({
  getThemeDefinition: () => null,
  singleAppearanceOf: () => null,
  subscribeToCustomThemes: () => () => {},
}));
vi.mock("../../../../../web/src/hooks/useTheme", () => ({
  setTheme: state.setTheme,
  setAppearanceMode: () => true,
  getThemeSnapshot: () => ({ appearanceMode: state.appearanceMode }),
}));
import { appAtomRegistry } from "../../../../../web/src/rpc/atomRegistry";
import { themeServerSettingsAtom } from "../../../../../web/src/state/server";
import { startDefaultThemeAdoption } from "../../../../../web/src/hooks/useDefaultTheme";

it.layer(NodeServices.layer)("agent stock reset adoption", (it) => {
  it.effect("adopts the agent's real reset once and keeps a later local choice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-agent-stock-" });
        const environmentId = EnvironmentId.make("environment:theme-stock-test");
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:theme-test",
          thread: undefined,
          client: { sessionId: "client:theme-test", label: "Test", access: "full-access" },
          capabilities: new Set(["orchestration"]),
          grantedScopes: ["settings:write"],
          reauthorize: () => Effect.void,
          issuedAt: 0,
        };
        const common = Layer.mergeAll(
          ThreadCommandExecutor.layer,
          Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Environment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId,
              label: "Test",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.0.0",
              capabilities: { repositoryIdentity: false },
            }),
          }),
          Settings.layerTest({ enableAgentThemeWrites: true, defaultTheme: "grove" }),
          ServerConfig.layerTest(process.cwd(), base),
        );
        const deps = ThemePublication.layer.pipe(Layer.provideMerge(common));
        yield* Effect.gen(function* () {
          const settings = yield* Settings.ServerSettingsService;
          const before = yield* settings.getSettings;
          const toolkit = yield* EnvironmentToolkit;
          const results = yield* toolkit
            .handle("goat_theme_set", { themeId: "" })
            .pipe(Stream.unwrap, Stream.runCollect);
          assert.deepEqual(results.at(-1)?.result, { themeId: "" });
          const emitted = yield* settings.getSettings;
          assert.isNotEmpty(emitted.defaultThemeSetAt);
          const values = new Map<string, string>();
          vi.stubGlobal("window", {
            localStorage: {
              getItem: (key: string) => values.get(key) ?? null,
              setItem: (key: string, value: string) => values.set(key, value),
            },
          });
          state.setTheme.mockClear();
          state.appearanceMode = "dark";
          const target = themeServerSettingsAtom as unknown as ReturnType<
            typeof Atom.make<ServerSettings>
          >;
          appAtomRegistry.set(target, before);
          const stop = startDefaultThemeAdoption();
          try {
            appAtomRegistry.set(target, emitted);
            assert.equal(state.setTheme.mock.calls.length, 1);
            assert.equal(state.setTheme.mock.calls[0]?.[0], "dark");
            assert.equal(state.selected, "dark");
            state.appearanceMode = "light";
            state.setTheme("light");
            appAtomRegistry.set(target, emitted);
            assert.equal(state.setTheme.mock.calls.length, 2);
            assert.equal(state.selected, "light");
          } finally {
            stop();
            vi.unstubAllGlobals();
          }
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
              Layer.provideMerge(deps),
            ),
          ),
        );
      }),
    ),
  );
});
