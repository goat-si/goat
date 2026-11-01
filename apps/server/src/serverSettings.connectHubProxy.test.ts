import { AuthStandardClientScopes, MemorySpaceId } from "@goat/contracts";
import * as Grants from "./auth/PairingGrantStore.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Access from "./auth/HubConnectAccess.ts";
import * as Auth from "./auth/EnvironmentAuth.ts";
import * as Sessions from "./auth/SessionStore.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Config from "./config.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Settings from "./serverSettings.ts";

const app = Layer.mergeAll(Auth.layer, Settings.layer).pipe(
  Layer.provide(Secrets.layer),
  Layer.provide(Environment.layerIdentity),
);
const storage = Sqlite.layerMemory.pipe(
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-connect-watch-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "one external withdrawal denies old tokens even when revocation fails, and external re-enable cannot revive them",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* Config.ServerConfig;
      const events = yield* PubSub.unbounded<{
        readonly event: FileSystem.WatchEvent;
        readonly seen: Deferred.Deferred<void>;
      }>();
      const registered = yield* Deferred.make<void>();
      let watchers = 0;
      const controlled = {
        ...fs,
        watch: (directory: string, options?: FileSystem.WatchOptions) =>
          Stream.unwrap(
            PubSub.subscribe(events).pipe(
              Effect.tap(() => {
                options?.onReady?.();
                watchers += 1;
                return watchers >= 2 ? Deferred.succeed(registered, undefined) : Effect.void;
              }),
              Effect.map((subscription) =>
                Stream.fromSubscription(subscription).pipe(
                  Stream.filter(({ event }) => path.dirname(event.path) === directory),
                  Stream.tap(({ seen }) => Deferred.succeed(seen, undefined)),
                  Stream.map(({ event }) => event),
                ),
              ),
            ),
          ),
      };
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const auth = yield* Auth.EnvironmentAuth;
        const sessions = yield* Sessions.SessionStore;
        const access = yield* Access.HubConnectAccess;
        const sql = yield* SqlClient.SqlClient;
        yield* settings.start;
        yield* auth.setCloudLinkTrust("test-account");
        yield* Deferred.await(registered);
        yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: true } });
        const token = yield* sessions.issue({
          subject: "cloud-connect",
          scopes: ["hub:proxy"],
          connectAccessGeneration: (yield* access.current).generation,
        });
        const grants = yield* Grants.PairingGrantStore;
        const mcpGrant = yield* grants.issueOneTimeToken({
          subject: "cloud-connect",
          scopes: [...AuthStandardClientScopes, "hub:proxy"],
          connectAccessGeneration: (yield* access.current).generation,
        });
        const grant = yield* auth.createCloudConnectPairingLink({
          proofKeyThumbprint: "device-key",
        });
        // Under valid link trust a Connect grant exchanges, so later refusals come from withdrawal.
        const control = yield* auth.createCloudConnectPairingLink({
          proofKeyThumbprint: "device-key",
        });
        yield* auth.exchangeBootstrapCredentialForAccessToken(
          control.credential,
          ["orchestration:read"],
          { deviceType: "mobile" },
          { proofKeyThumbprint: "device-key" },
        );
        yield* sql`CREATE TRIGGER fail_connect_cleanup BEFORE UPDATE ON auth_sessions WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected revoke failure'); END`;
        yield* sql`CREATE TRIGGER fail_connect_grant_cleanup BEFORE UPDATE ON auth_pairing_links WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(FAIL, 'injected grant revoke failure'); END`;
        const publish = Effect.fn("test.publishHubPolicy")(function* (
          enabled: boolean,
          consent: boolean,
        ) {
          const changes = yield* settings.subscribeChanges;
          yield* fs.writeFileString(
            config.settingsPath,
            JSON.stringify({ hub: { enabled, connectDevicesHubProxy: consent } }),
          );
          const seen = yield* Deferred.make<void>();
          yield* PubSub.publish(events, {
            event: { _tag: "Update" as const, path: config.settingsPath },
            seen,
          });
          yield* Deferred.await(seen);
          yield* TestClock.adjust(100);
          yield* changes.pipe(Stream.runHead);
        });
        const request = HttpServerRequest.fromWeb(
          new Request("http://hub.test/api/auth/session", {
            headers: { authorization: `Bearer ${token.token}` },
          }),
        );
        yield* publish(true, false);
        expect(
          yield* auth
            .consumeMcpApprovalCode(mcpGrant.credential, "full-access")
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect(yield* auth.authenticateHttpRequest(request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        expect(
          yield* auth
            .exchangeBootstrapCredentialForAccessToken(
              grant.credential,
              ["orchestration:read"],
              { deviceType: "mobile" },
              { proofKeyThumbprint: "device-key" },
            )
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        yield* sql`DROP TRIGGER fail_connect_cleanup`;
        yield* sql`DROP TRIGGER fail_connect_grant_cleanup`;
        yield* publish(true, true);
        expect(yield* sessions.verify(token.token).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "SessionTokenRevokedError" },
        });
        expect(yield* auth.authenticateHttpRequest(request).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
        });
        const fresh = yield* auth.createCloudConnectPairingLink({
          proofKeyThumbprint: "device-key",
        });
        expect(fresh.scopes).toContain("hub:proxy");
        yield* publish(false, true);
        expect((yield* settings.getSettings).hub.connectDevicesHubProxy).toBe(true);
        expect((yield* access.current).allowed).toBe(false);
      }).pipe(Effect.provide(app), Effect.provideService(FileSystem.FileSystem, controlled));
    }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect(
  "an external opt-out withdraws Connect hub access while the memory hub keeps its epoch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* Config.ServerConfig;
      const events = yield* PubSub.unbounded<{
        readonly event: FileSystem.WatchEvent;
        readonly seen: Deferred.Deferred<void>;
      }>();
      const registered = yield* Deferred.make<void>();
      let watchers = 0;
      const controlled = {
        ...fs,
        watch: (directory: string, options?: FileSystem.WatchOptions) =>
          Stream.unwrap(
            PubSub.subscribe(events).pipe(
              Effect.tap(() => {
                options?.onReady?.();
                watchers += 1;
                return watchers >= 2 ? Deferred.succeed(registered, undefined) : Effect.void;
              }),
              Effect.map((subscription) =>
                Stream.fromSubscription(subscription).pipe(
                  Stream.filter(({ event }) => path.dirname(event.path) === directory),
                  Stream.tap(({ seen }) => Deferred.succeed(seen, undefined)),
                  Stream.map(({ event }) => event),
                ),
              ),
            ),
          ),
      };
      yield* Effect.gen(function* () {
        const settings = yield* Settings.ServerSettingsService;
        const access = yield* Access.HubConnectAccess;
        yield* settings.start;
        yield* Deferred.await(registered);
        const writeExternal = Effect.fn("test.writeExternalSettings")(function* (contents: object) {
          const changes = yield* settings.subscribeChanges;
          yield* fs.writeFileString(config.settingsPath, JSON.stringify(contents));
          const seen = yield* Deferred.make<void>();
          yield* PubSub.publish(events, {
            event: { _tag: "Update" as const, path: config.settingsPath },
            seen,
          });
          yield* Deferred.await(seen);
          yield* TestClock.adjust(100);
          yield* changes.pipe(Stream.runHead);
        });
        const memoryHub = {
          mode: "hub",
          memorySpaceId: MemorySpaceId.make("00000000-0000-4000-8000-000000000092"),
        };
        yield* writeExternal({
          memoryHub,
          memoryHubVersion: 7,
          hub: { enabled: true, connectDevicesHubProxy: true },
        });
        expect((yield* access.current).allowed).toBe(true);
        // A hand edit that drops memoryHubVersion keeps the memory hub, but not Connect hub access.
        yield* writeExternal({ memoryHub, hub: { enabled: true, connectDevicesHubProxy: false } });
        expect((yield* access.current).allowed).toBe(false);
      }).pipe(Effect.provide(app), Effect.provideService(FileSystem.FileSystem, controlled));
    }).pipe(Effect.scoped, Effect.provide(storage)),
);
