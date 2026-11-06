import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as NetService from "@goat/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { resolveServerConfig } from "./config.ts";

it.layer(NodeServices.layer)("automatic port configuration", (it) => {
  const minimalWebFlags = (baseDir: string) => ({
    mode: Option.some("web" as const),
    port: Option.some(3773),
    host: Option.none<string>(),
    baseDir: Option.some(baseDir),
    cwd: Option.none<string>(),
    devUrl: Option.none<URL>(),
    noBrowser: Option.none<boolean>(),
    bootstrapFd: Option.none<number>(),
    autoBootstrapProjectFromCwd: Option.none<boolean>(),
    logWebSocketEvents: Option.none<boolean>(),
    tailscaleServeEnabled: Option.none<boolean>(),
    tailscaleServePort: Option.none<number>(),
  });

  it.effect("uses the automatic port selector only when no port is configured", () =>
    Effect.gen(function* () {
      const baseDir = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "goat-cli-auto-port-" })),
      );
      const selected: number[] = [];
      const selectAutomaticPort = (preferred: number) =>
        Effect.sync(() => {
          selected.push(preferred);
          return 50_123;
        });
      const resolvePort = (flags: {
        readonly mode?: Option.Option<"web" | "desktop">;
        readonly port: Option.Option<number>;
      }) =>
        resolveServerConfig({ ...minimalWebFlags(baseDir), ...flags }, Option.none(), {
          selectAutomaticPort,
        }).pipe(
          Effect.map((config) => config.port),
          Effect.provide(
            Layer.merge(
              NetService.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            ),
          ),
        );

      expect(yield* resolvePort({ port: Option.none() })).toBe(50_123);
      expect(selected).toEqual([3773]);
      expect(yield* resolvePort({ port: Option.some(8788) })).toBe(8788);
      expect(
        yield* resolvePort({ mode: Option.some("desktop" as const), port: Option.none() }),
      ).toBe(3773);
      expect(selected).toEqual([3773]);
    }),
  );
});
