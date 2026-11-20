import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

const environmentId = EnvironmentId.make("environment:theme-test");
const theme = {
  name: "Nightfall",
  appearance: "dark",
  canvas: "#112233",
  accent: "#aabbcc",
  css: '[data-slot="sidebar"]{color:red}',
} as const;

it.layer(NodeServices.layer)("theme.set agent surface", (it) => {
  it.effect.each([
    {
      enabled: false,
      scopes: ["settings:write"] as AuthEnvironmentScope[],
      unsafe: false,
      succeeds: false,
    },
    { enabled: true, scopes: [] as AuthEnvironmentScope[], unsafe: false, succeeds: false },
    {
      enabled: true,
      scopes: ["settings:write"] as AuthEnvironmentScope[],
      unsafe: true,
      succeeds: false,
    },
    {
      enabled: true,
      scopes: ["settings:write"] as AuthEnvironmentScope[],
      unsafe: false,
      succeeds: true,
    },
  ])("enforces access and CSS policy", ({ enabled, scopes, unsafe, succeeds }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "goat-theme-agent-" });
        const scope: McpInvocationContext.McpInvocationScope = {
          environmentId,
          requestNamespace: "client:theme-test",
          thread: undefined,
          client: { sessionId: "client:theme-test", label: "Test", access: "full-access" },
          capabilities: new Set(["orchestration"]),
          grantedScopes: scopes,
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
          Settings.layerTest({ enableAgentThemeWrites: enabled }),
          ServerConfig.layerTest(process.cwd(), base),
        );
        const deps = ThemePublication.layer.pipe(Layer.provideMerge(common));
        yield* Effect.gen(function* () {
          const toolkit = yield* EnvironmentToolkit;
          const results = yield* toolkit
            .handle("goat_theme_set", {
              themeId: "nightfall",
              theme: unsafe ? { ...theme, css: '@import "https://evil.example/x.css";' } : theme,
            })
            .pipe(Stream.unwrap, Stream.runCollect);
          const result = results.at(-1)?.result;
          const output = path.join(base, "userdata", "themes", "nightfall.json");
          assert.equal(yield* fs.exists(output), succeeds);
          const settings = yield* Settings.ServerSettingsService;
          assert.equal((yield* settings.getSettings).defaultTheme, succeeds ? "nightfall" : "");
          if (succeeds) {
            assert.deepEqual(result, { themeId: "nightfall" });
            assert.include(yield* fs.readFileString(output), "[data-goat-theme-root]");
          } else {
            assert.property(result, "code");
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
