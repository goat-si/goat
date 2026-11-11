// @effect-diagnostics nodeBuiltinImport:off - Builds a Chromium-shaped cookie
// table with the same native bindings the source reads.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as NodeSqlite from "node:sqlite";

import {
  BROWSER_IMPORT_SOURCES,
  isSourceInstalled,
  listSourceProfiles,
  resolveCookieDatabase,
  sourcePathContext,
} from "./Sources.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const writeCookieDatabase = (file: string, count: number) =>
  Effect.sync(() => {
    const database = new NodeSqlite.DatabaseSync(file);
    database.exec("create table cookies (host_key text, name text)");
    const insert = database.prepare("insert into cookies (host_key, name) values (?, ?)");
    for (let index = 0; index < count; index += 1) insert.run("example.test", `c${index}`);
    database.close();
  });

describe("isSourceInstalled with XDG config homes", () => {
  it.effect.each([undefined, "", "relative-config", "relocated", "chrome-override"])(
    "discovers Linux Chromium profiles with XDG_CONFIG_HOME=%s",
    (configHome) =>
      run(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-sources-xdg-" });
          const xdgConfigHome =
            configHome === "relocated" || configHome === "chrome-override"
              ? path.join(home, "config")
              : configHome;
          const chromeConfigHome =
            configHome === "chrome-override" ? path.join(home, ".config") : undefined;
          const context = yield* sourcePathContext.pipe(
            Effect.provideService(HostProcess.Environment, {
              HOME: home,
              XDG_CONFIG_HOME: xdgConfigHome,
              CHROME_CONFIG_HOME: chromeConfigHome,
            }),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
          const configRoot =
            chromeConfigHome ??
            (configHome === "relocated" ? path.join(home, "config") : path.join(home, ".config"));
          const source = BROWSER_IMPORT_SOURCES.find((source) => source.id === "chrome")!;
          const root = path.join(configRoot, "google-chrome");
          const database = path.join(root, "Default", "Network", "Cookies");
          assert.isFalse(yield* isSourceInstalled(source, context));
          yield* fileSystem.makeDirectory(path.dirname(database), { recursive: true });
          yield* writeCookieDatabase(database, 2);
          yield* fileSystem.writeFileString(
            path.join(root, "Local State"),
            '{"profile":{"info_cache":{"Default":{"name":"Fixture"}}}}',
          );

          assert.isTrue(yield* isSourceInstalled(source, context));
          assert.deepEqual(yield* listSourceProfiles(source, context), [
            { directory: "Default", name: "Fixture", cookieCount: 2 },
          ]);
          assert.equal(yield* resolveCookieDatabase(source, context, "Default"), database);
        }),
      ),
  );
});
