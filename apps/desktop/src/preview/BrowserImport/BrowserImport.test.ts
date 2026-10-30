import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as BrowserSession from "../BrowserSession.ts";
import * as BrowserImport from "./BrowserImport.ts";
import { BROWSER_IMPORT_SOURCES, sourcePathContext } from "./Sources.ts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";

const helium = BROWSER_IMPORT_SOURCES.find((source) => source.id === "helium")!;

const cookie = {
  url: "https://rejected.example/path",
  name: "session",
  value: "value",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "lax" as const,
};

const layerRejectedBeforeSession = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    getPartition: () => Effect.die("getPartition must not be reached"),
    isPartition: () => false,
    getSession: () => Effect.die("getSession must not be reached"),
    clearCookies: () => Effect.die("clearCookies must not be reached"),
    clearCache: () => Effect.die("clearCache must not be reached"),
  }),
);

const withImporter = Effect.fnUntraced(function* (platform: "darwin" | "win32" = "darwin") {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-import-" });
  const layerEnvironment = Layer.succeed(HostProcess.Environment, { HOME: home });
  const context = yield* sourcePathContext.pipe(
    Effect.provideService(HostProcess.Environment, { HOME: home }),
    Effect.provideService(HostProcess.Platform, "darwin"),
  );
  const root = helium.userDataDirectory(context);
  if (root === undefined) throw new Error("Helium has no macOS user-data directory");
  yield* fileSystem.makeDirectory(`${root}/Default`, { recursive: true });
  yield* fileSystem.writeFileString(`${root}/Default/Cookies`, "db");

  const importer = yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(layerRejectedBeforeSession),
        Layer.provide(layerEnvironment),
        Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, "/Applications/T3 Code.app")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
  return { importer, home, root };
});

describe("BrowserImport.importCookies", () => {
  it.effect("refuses Chromium refresh on Windows with an app-bound encryption reason", () =>
    Effect.gen(function* () {
      const { importer } = yield* withImporter("win32");
      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "chrome",
            sourceProfileDirectory: "Default",
            targetProfileId: "default",
            origins: ["https://example.com"],
          },
          scope: "fixture",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "appBoundEncryption");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("rejects a source profile the browser never reported", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const { importer, home } = yield* withImporter();

      yield* fileSystem.makeDirectory(`${home}/secrets`, { recursive: true });
      yield* fileSystem.writeFileString(`${home}/secrets/Cookies`, "not-a-db");

      const error = yield* importer
        .importCookies({
          input: {
            sourceId: "helium",
            sourceProfileDirectory: "../../../../secrets",
            targetProfileId: "default",
          },
          scope: "persist:t3code-preview-test", // goat-rename: legacy
          persistent: true,
        })
        .pipe(Effect.flip);

      assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
      assert.equal(error.reason, "unknownSourceProfile");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses to import while the source browser holds its profile",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { importer, root } = yield* withImporter();
        yield* fileSystem.symlink("host-that-does-not-exist-1234", `${root}/SingletonLock`);

        const error = yield* importer
          .importCookies({
            input: {
              sourceId: "helium",
              sourceProfileDirectory: "Default",
              targetProfileId: "default",
            },
            scope: "persist:t3code-preview-test", // goat-rename: legacy
            persistent: true,
          })
          .pipe(Effect.flip);

        assert.equal(error.reason, "browserRunning");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("BrowserImport.writeCookies", () => {
  it.effect("replaces all matching target cookies and reports shared domains", () =>
    Effect.gen(function* () {
      const existing = [
        {
          domain: "a.example.com",
          hostOnly: true,
          name: "old",
          path: "/",
          secure: false,
          httpOnly: true,
          sameSite: "lax" as const,
        },
        {
          domain: ".example.com",
          hostOnly: false,
          name: "stale",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax" as const,
        },
        {
          domain: "other.test",
          hostOnly: true,
          name: "keep",
          path: "/",
          secure: false,
          httpOnly: true,
          sameSite: "lax" as const,
        },
        {
          domain: "b.example.com",
          hostOnly: true,
          name: "sibling",
          path: "/",
          secure: false,
          httpOnly: true,
          sameSite: "lax" as const,
        },
        {
          domain: "a.example.com",
          hostOnly: true,
          name: "other-path",
          path: "/other",
          secure: false,
          httpOnly: true,
          sameSite: "lax" as const,
        },
      ];
      const removed: Array<{
        name?: string;
        domain?: string;
        path?: string;
        expirationDate?: number;
      }> = [];
      const written: string[] = [];
      const result = yield* BrowserImport.refreshCookies(
        {
          cookies: {
            get: () => Promise.resolve(existing),
            set: (details) => {
              if (details.expirationDate === 1) removed.push(details);
              else written.push(details.name ?? "");
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        },
        {
          cookies: [
            { ...cookie, url: "https://a.example.com/", name: "new", domain: undefined },
            { ...cookie, url: "https://example.com/", name: "shared", domain: ".example.com" },
            { ...cookie, url: "https://other.test/", name: "outside" },
          ],
          undecryptable: 0,
          undecryptableHosts: [],
        },
        ["https://a.example.com"],
      );
      assert.deepEqual(
        removed.map(({ name, domain, path, expirationDate }) => ({
          name,
          domain,
          path,
          expirationDate,
        })),
        [
          { name: "old", domain: undefined, path: "/", expirationDate: 1 },
          { name: "stale", domain: ".example.com", path: "/", expirationDate: 1 },
          { name: "other-path", domain: undefined, path: "/other", expirationDate: 1 },
        ],
      );
      assert.deepEqual(written.sort(), ["new", "shared"]);
      assert.deepEqual(result.sharedDomains, ["example.com"]);
      assert.deepEqual(result.origins, [
        { origin: "https://a.example.com", imported: 2, skipped: 0 },
      ]);
    }),
  );

  it.effect("does not refresh secure cookies for an http origin", () =>
    Effect.gen(function* () {
      const written: string[] = [];
      const result = yield* BrowserImport.refreshCookies(
        {
          cookies: {
            get: () => Promise.resolve([]),
            set: (details) => {
              written.push(details.name ?? "");
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        },
        {
          cookies: [{ ...cookie, url: "https://a.example.com/", name: "secure" }],
          undecryptable: 0,
          undecryptableHosts: [],
        },
        ["http://a.example.com"],
      );
      assert.deepEqual(written, []);
      assert.equal(result.imported, 0);
    }),
  );
  it.effect("flushes the store after writing, and reports success if the flush fails", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: () => {
              events.push("set");
              return Promise.resolve();
            },
            flushStore: () => {
              events.push("flush");
              return Promise.reject(new Error("fixture flush failure"));
            },
          },
        },
        { cookies: [cookie, cookie], undecryptable: 0, undecryptableHosts: [] },
      );

      assert.deepEqual(events, ["set", "set", "flush"]);
      assert.deepEqual(result, { imported: 2, skipped: 0, skippedDomains: [] });
    }),
  );
});
