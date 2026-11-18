import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ServerSettings } from "@goat/contracts";
import { mergeProviderInstanceEnvironment } from "@goat/provider-core/server/instanceEnvironment";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import type { CursorCredentialSource } from "./accountCache.ts";
import * as CursorAccountReader from "./CursorAccountReader.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";
import { CursorDriver } from "./driver.ts";

// Each row class of the account scan's decision table, through the driver's usage reader. The
// account reader is the scan's only way to the network: every credential it gets is recorded.

const decodeSettings = Schema.decodeUnknownEffect(ServerSettings);
const PRIVATE = "https://private.invalid";
const PRODUCTION = "https://api2.cursor.sh";

const cursor = (environment: Record<string, string> = {}, config: unknown = {}) => ({
  driver: "cursor",
  enabled: true,
  config,
  environment: Object.entries(environment).map(([name, value]) => ({ name, value })),
});

const signIn = (backendUrl: string, apiKey: string, apiKeyExpiresAtMs?: number) =>
  JSON.stringify({
    version: 1,
    backendUrl,
    apiKey,
    createdAtMs: 0,
    ...(apiKeyExpiresAtMs === undefined ? {} : { apiKeyExpiresAtMs }),
  });

interface Case {
  /** The server's environment around a home that holds a Cursor CLI login file. */
  readonly server: (home: string) => NodeJS.ProcessEnv;
  readonly instances: Record<string, ReturnType<typeof cursor>>;
  /** Instances the scan includes without a settings record, as UsageService adds the default. */
  readonly unrecorded?: ReadonlyArray<string>;
  readonly signIns?: Record<string, string>;
  /** Keys whose account read fails. */
  readonly failing?: ReadonlyArray<string>;
}

const scanCase = (input: Case) => {
  const reads: Array<CursorCredentialSource> = [];
  const failing = new Set(input.failing ?? []);
  const reader = Layer.succeed(CursorAccountReader.CursorAccountReader, {
    read: (source) =>
      Effect.sync(() => {
        reads.push(source);
        const name =
          typeof source === "object" && source.kind === "apiKey" ? source.apiKey : "host";
        return failing.has(name)
          ? { accountKey: null, records: [], missing: false, error: "read failed" }
          : { accountKey: "account-" + name, records: [], missing: false, error: null };
      }),
  });
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-scan-home-" });
    // Where the server's CLI login lives on macOS and on Linux.
    for (const directory of [home + "/.cursor", home + "/.config/cursor"]) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(directory + "/auth.json", "{}");
    }
    const server = input.server(home);
    // Past every fixture's expiry of 1.
    yield* TestClock.adjust("1 second");
    const host = yield* ProviderHost.ProviderHost;
    for (const [id, record] of Object.entries(input.signIns ?? {})) {
      yield* (yield* host.credentials("cursor", ProviderInstanceId.make(id))).set(
        new TextEncoder().encode(record),
      );
    }
    const settings = yield* decodeSettings({
      providerInstances: input.instances,
      cursorKeychainUsageEnabled: false,
    });
    const usage = CursorDriver.usage;
    if (usage?.kind !== "scan") return yield* Effect.die("Cursor reads account usage by scan");
    const ids = [...Object.keys(input.instances), ...(input.unrecorded ?? [])];
    // What UsageService passes: the merged environment and whether a record exists.
    const instances = yield* Effect.forEach(ids, (id) =>
      mergeProviderInstanceEnvironment(
        settings.providerInstances[ProviderInstanceId.make(id)]?.environment,
        { ...server },
      ).pipe(
        Effect.map((environment) => ({
          instanceId: ProviderInstanceId.make(id),
          config: undefined,
          environment,
          configured: Object.hasOwn(input.instances, id),
        })),
      ),
    );
    const scans = yield* usage
      .scan({ instances, settings, windowStartMs: 0, retentionCutoffMs: 0, awaitRefresh: true })
      .pipe(
        Effect.provide(CursorUsageAccounts.layer.pipe(Layer.provide(reader))),
        Effect.provideService(HostProcess.Environment, server),
      );
    const keys = reads.flatMap((source) =>
      typeof source === "object" && source.kind === "apiKey" ? [source.apiKey] : [],
    );
    const hostReads = reads.filter(
      (source) => typeof source === "string" || source.kind === "keychain",
    );
    const note = scans
      .flatMap((entry) => (entry.files === null ? [entry.message] : []))
      .join(" | ");
    return { keys, hostReads, scans, note, home };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        TestProviderHost.layer(),
        Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
      ),
    ),
    Effect.scoped,
  );
};

/** A production server whose own Cursor login is a file the scan may read. */
const productionServer =
  (extra: NodeJS.ProcessEnv = {}) =>
  (home: string): NodeJS.ProcessEnv => ({
    AGENT_CLI_CREDENTIAL_STORE: "file",
    HOME: home,
    USERPROFILE: home,
    ...extra,
  });

describe("Cursor account scan decisions", () => {
  it.effect("one default instance with nothing of its own shows the server's CLI login", () =>
    Effect.gen(function* () {
      const result = yield* scanCase({
        server: productionServer(),
        instances: {},
        unrecorded: ["cursor"],
      });
      assert.deepStrictEqual(result.keys, []);
      assert.strictEqual(result.hostReads.length, 1);
      assert.strictEqual(result.note, "");
    }),
  );

  it.effect(
    "never reads the host login of a server that is not on Cursor's backend and endpoint",
    () =>
      Effect.gen(function* () {
        for (const server of [
          productionServer({ CURSOR_BACKEND_URL: PRIVATE }),
          productionServer({ CURSOR_API_ENDPOINT: PRIVATE }),
        ]) {
          const result = yield* scanCase({ server, instances: {} });
          assert.deepStrictEqual(result.hostReads, []);
          assert.deepStrictEqual(result.keys, []);
          assert.include(result.note, "not Cursor's");
        }
      }),
  );

  it.effect(
    "sends no credential to Cursor for a backend or usage endpoint that is not Cursor's",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<
          readonly [string, NodeJS.ProcessEnv, ReturnType<typeof cursor>]
        > = [
          [
            "private-endpoint",
            {},
            cursor({ CURSOR_API_ENDPOINT: PRIVATE, CURSOR_API_KEY: "key-e" }),
          ],
          [
            "private-endpoint-setting",
            {},
            cursor({ CURSOR_API_KEY: "key-f" }, { apiEndpoint: PRIVATE }),
          ],
          [
            "inherits-private-endpoint",
            { CURSOR_API_KEY: "key-g", CURSOR_API_ENDPOINT: PRIVATE },
            cursor(),
          ],
          ["private-backend", {}, cursor({ CURSOR_BACKEND_URL: PRIVATE, CURSOR_API_KEY: "key-a" })],
          [
            "http-backend",
            {},
            cursor({ CURSOR_BACKEND_URL: "http://api2.cursor.sh", CURSOR_API_KEY: "key-b" }),
          ],
          [
            "path-backend",
            {},
            cursor({ CURSOR_BACKEND_URL: PRODUCTION + "/v2", CURSOR_API_KEY: "key-c" }),
          ],
          [
            "malformed-backend",
            {},
            cursor({ CURSOR_BACKEND_URL: "not a url", CURSOR_API_KEY: "key-d" }),
          ],
          [
            "inherits-private-backend",
            { CURSOR_API_KEY: "key-h", CURSOR_BACKEND_URL: PRIVATE },
            cursor(),
          ],
        ];
        for (const [id, server, instance] of cases) {
          const result = yield* scanCase({
            server: productionServer(server),
            instances: { [id]: instance },
          });
          assert.deepStrictEqual(result.keys, [], id);
          assert.deepStrictEqual(result.hostReads, [], id);
          assert.include(result.note, id);
        }
      }),
  );

  it.effect(
    "reads an inherited key when the instance names the server's backend or endpoint another way",
    () =>
      Effect.gen(function* () {
        const instances = {
          "same-backend": cursor({ CURSOR_BACKEND_URL: "https://API2.cursor.sh:443/" }),
          "same-endpoint": cursor({ CURSOR_API_ENDPOINT: "https://api2.cursor.sh/" }),
          "same-endpoint-setting": cursor({}, { apiEndpoint: "HTTPS://api2.cursor.sh:443" }),
        };
        for (const [id, instance] of Object.entries(instances)) {
          const result = yield* scanCase({
            server: productionServer({
              CURSOR_API_KEY: "server-key",
              CURSOR_BACKEND_URL: PRODUCTION,
            }),
            instances: { [id]: instance },
          });
          assert.deepStrictEqual(result.keys, ["server-key"], id);
          assert.deepStrictEqual(result.hostReads, [], id);
          assert.strictEqual(result.note, "", id);
        }
      }),
  );

  it.effect(
    "keeps the server's credentials from an instance that names a destination of its own",
    () =>
      Effect.gen(function* () {
        const privateBackend = yield* scanCase({
          server: productionServer({
            CURSOR_API_KEY: "server-key",
            CURSOR_AUTH_TOKEN: "server-token",
            CURSOR_BACKEND_URL: PRIVATE,
          }),
          instances: { "names-cursor-backend": cursor({ CURSOR_BACKEND_URL: PRODUCTION }) },
        });
        assert.deepStrictEqual(privateBackend.keys, []);
        assert.deepStrictEqual(privateBackend.hostReads, []);
        assert.include(privateBackend.note, "names-cursor-backend");
        const privateEndpoint = yield* scanCase({
          server: productionServer({ CURSOR_API_KEY: "server-key", CURSOR_API_ENDPOINT: PRIVATE }),
          instances: {
            "names-cursor-endpoint": cursor({ CURSOR_API_ENDPOINT: PRODUCTION }),
            "own-key": cursor({ CURSOR_API_ENDPOINT: PRODUCTION, CURSOR_API_KEY: "own-key" }),
          },
        });
        assert.deepStrictEqual(privateEndpoint.keys, ["own-key"]);
        assert.deepStrictEqual(privateEndpoint.hostReads, []);
        assert.include(privateEndpoint.note, "names-cursor-endpoint");
      }),
  );

  it.effect(
    "reads only a valid stored sign-in for Cursor's backend and never borrows the host's",
    () =>
      Effect.gen(function* () {
        // Alone, an expired sign-in for Cursor's backend must not hand over to the host's login.
        const alone = yield* scanCase({
          server: productionServer(),
          instances: { "expired-alone": cursor() },
          signIns: { "expired-alone": signIn(PRODUCTION, "expired-key", 1) },
        });
        assert.deepStrictEqual(alone.hostReads, []);
        assert.deepStrictEqual(alone.keys, []);
        assert.include(alone.note, "expired-alone");
        const result = yield* scanCase({
          server: productionServer(),
          instances: {
            valid: cursor(),
            "expired-production": cursor(),
            "expired-private": cursor(),
            "other-backend": cursor(),
            unreadable: cursor(),
          },
          signIns: {
            valid: signIn(PRODUCTION, "valid-key"),
            "expired-production": signIn(PRODUCTION, "expired-key", 1),
            "expired-private": signIn(PRIVATE, "expired-private-key", 1),
            "other-backend": signIn(PRIVATE, "private-key"),
            unreadable: "not a stored sign-in",
          },
        });
        assert.deepStrictEqual(result.keys, ["valid-key"]);
        assert.deepStrictEqual(result.hostReads, []);
        for (const id of ["expired-production", "expired-private", "other-backend", "unreadable"]) {
          assert.include(result.note, id);
        }
      }),
  );

  it.effect("prefers a key, then a valid sign-in, and never reads with a token", () =>
    Effect.gen(function* () {
      const result = yield* scanCase({
        server: productionServer(),
        instances: {
          "key-and-expired-sign-in": cursor({ CURSOR_API_KEY: "own-key" }),
          "sign-in-and-token": cursor({ CURSOR_AUTH_TOKEN: "own-token" }),
          "token-only": cursor({ CURSOR_AUTH_TOKEN: "lonely-token" }),
        },
        signIns: {
          "key-and-expired-sign-in": signIn(PRODUCTION, "expired-key", 1),
          "sign-in-and-token": signIn(PRODUCTION, "signed-in-key"),
        },
      });
      assert.deepStrictEqual(result.keys.toSorted(), ["own-key", "signed-in-key"]);
      assert.deepStrictEqual(result.hostReads, []);
      assert.include(result.note, "token-only");
      const inherited = yield* scanCase({
        server: productionServer({ CURSOR_AUTH_TOKEN: "server-token" }),
        instances: { "inherits-token": cursor() },
      });
      assert.deepStrictEqual(inherited.hostReads, []);
      assert.include(inherited.note, "inherits-token");
    }),
  );

  it.effect("treats an empty key or token as absent", () =>
    Effect.gen(function* () {
      const result = yield* scanCase({
        server: productionServer(),
        instances: { blank: cursor({ CURSOR_API_KEY: "  ", CURSOR_AUTH_TOKEN: "" }) },
      });
      assert.deepStrictEqual(result.keys, []);
      assert.strictEqual(result.hostReads.length, 1);
    }),
  );

  it.effect("leaves out an instance whose settings cannot be decoded, inferring no endpoint", () =>
    Effect.gen(function* () {
      const result = yield* scanCase({
        server: productionServer(),
        instances: {
          undecodable: cursor({ CURSOR_API_KEY: "undecodable-key" }, { apiEndpoint: 42 }),
        },
      });
      assert.deepStrictEqual(result.keys, []);
      assert.deepStrictEqual(result.hostReads, []);
      assert.include(result.note, "undecodable");
    }),
  );

  it.effect("keeps every left-out instance in its note, whatever else the scan reads", () =>
    Effect.gen(function* () {
      const excludedAndNone = yield* scanCase({
        server: productionServer(),
        instances: {
          none: cursor(),
          left: cursor({ CURSOR_BACKEND_URL: PRIVATE, CURSOR_API_KEY: "left-key" }),
        },
      });
      assert.deepStrictEqual(excludedAndNone.keys, []);
      assert.deepStrictEqual(excludedAndNone.hostReads, []);
      assert.include(excludedAndNone.note, "left");
      const usable = yield* scanCase({
        server: productionServer(),
        instances: {
          usable: cursor({ CURSOR_API_KEY: "usable-key" }),
          twin: cursor({ CURSOR_API_KEY: "usable-key" }),
          failing: cursor({ CURSOR_API_KEY: "failing-key" }),
          left: cursor({ CURSOR_BACKEND_URL: PRIVATE, CURSOR_API_KEY: "left-key" }),
        },
        failing: ["failing-key"],
      });
      // Keys are deduplicated before requesting; the failed read and the note both stay.
      assert.deepStrictEqual(usable.keys.toSorted(), ["failing-key", "usable-key"]);
      assert.deepStrictEqual(usable.hostReads, []);
      assert.include(usable.note, "left");
      const usableAndNone = yield* scanCase({
        server: productionServer(),
        instances: { usable: cursor({ CURSOR_API_KEY: "usable-key" }), none: cursor() },
      });
      assert.deepStrictEqual(usableAndNone.keys, ["usable-key"]);
      assert.deepStrictEqual(usableAndNone.hostReads, []);
    }),
  );

  it.effect("decides and reads the host login from one copy of the host environment", () =>
    Effect.gen(function* () {
      // A copy reads each property's descriptor before its value; any later direct read sees a
      // server that moved to a private backend and another home.
      let copying: string | symbol | undefined;
      const moved: NodeJS.ProcessEnv = {
        CURSOR_BACKEND_URL: PRIVATE,
        HOME: "/moved-home",
        USERPROFILE: "/moved-home",
      };
      const server = (home: string) =>
        new Proxy<NodeJS.ProcessEnv>(productionServer()(home), {
          getOwnPropertyDescriptor: (object, key) => {
            copying = key;
            return Reflect.getOwnPropertyDescriptor(object, key);
          },
          get: (object, key) => {
            const copied = copying === key;
            copying = undefined;
            return !copied && typeof key === "string" && key in moved
              ? moved[key]
              : Reflect.get(object, key);
          },
        });
      const result = yield* scanCase({ server, instances: {}, unrecorded: ["cursor"] });
      assert.strictEqual(result.hostReads.length, 1);
      assert.isTrue(String(result.hostReads[0]).startsWith(result.home + "/"));
    }),
  );
  it.effect("judges an inherited key and the instance's backend against the host it copied", () =>
    Effect.gen(function* () {
      // The copy sees "copied"; any later direct read sees the host after it moved to "later".
      const movingServer =
        (copied: NodeJS.ProcessEnv, later: NodeJS.ProcessEnv) =>
        (home: string): NodeJS.ProcessEnv => {
          let copying: string | symbol | undefined;
          return new Proxy<NodeJS.ProcessEnv>(productionServer(copied)(home), {
            getOwnPropertyDescriptor: (object, key) => {
              copying = key;
              return Reflect.getOwnPropertyDescriptor(object, key);
            },
            get: (object, key) => {
              const fromCopy = copying === key;
              copying = undefined;
              return !fromCopy && typeof key === "string" && key in later
                ? later[key]
                : Reflect.get(object, key);
            },
          });
        };
      const instances = { "names-cursor": cursor({ CURSOR_BACKEND_URL: PRODUCTION }) };
      // Copied on a private backend: the inherited key is the private server's and stays home.
      const leftPrivate = yield* scanCase({
        server: movingServer(
          { CURSOR_API_KEY: "private-server-key", CURSOR_BACKEND_URL: PRIVATE },
          { CURSOR_API_KEY: "later-key", CURSOR_BACKEND_URL: PRODUCTION },
        ),
        instances,
      });
      assert.deepStrictEqual(leftPrivate.keys, []);
      assert.deepStrictEqual(leftPrivate.hostReads, []);
      // Copied on Cursor's backend: the instance names the same backend and reads the copied key.
      const stayedProduction = yield* scanCase({
        server: movingServer(
          { CURSOR_API_KEY: "copied-key", CURSOR_BACKEND_URL: PRODUCTION },
          { CURSOR_API_KEY: "later-key", CURSOR_BACKEND_URL: PRIVATE },
        ),
        instances,
      });
      assert.deepStrictEqual(stayedProduction.keys, ["copied-key"]);
    }),
  );
});
