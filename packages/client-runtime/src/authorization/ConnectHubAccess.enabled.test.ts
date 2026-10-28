import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { HubProxyConnectionProfile } from "../connection/catalog.ts";
import { ConnectionProfileStore } from "../connection/profileStore.ts";
import { ConnectionCredentialStore } from "../connection/credentialStore.ts";
import * as HubAuth from "../connection/hubProxyAuthSource.ts";
import { requestHubProxyJson } from "../connection/hubProxyHttp.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as Remote from "./service.ts";
import {
  makeHarness,
  persistedToken,
  ENVIRONMENT_ID,
  DESCRIPTOR,
  accessToken,
} from "./remoteAuthorization.testkit.ts";

vi.mock("@goat/shared/goatConnect", async (original) => ({
  ...(await original<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

it.effect(
  "cached credential retry keeps standard access; same-account sign-in remints proxy headers",
  () =>
    Effect.gen(function* () {
      const denied = () => Response.json({ requiredScope: "hub:proxy" }, { status: 403 });
      const harness = yield* makeHarness({
        initialToken: persistedToken(),
        responses: [
          denied(),
          denied(),
          Response.json(DESCRIPTOR),
          accessToken("privileged", [...AuthStandardClientScopes, "hub:proxy"].join(" ")),
          Response.json({ nodeId: "node", threads: [] }),
        ],
      });
      yield* Effect.gen(function* () {
        const remote = yield* Remote.RemoteEnvironmentAuthorization;
        const source = yield* HubAuth.make.pipe(
          Effect.provideService(ConnectionProfileStore, {
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
          Effect.provideService(ConnectionCredentialStore, {
            get: () => Effect.die("No node credential"),
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
          Effect.provideService(Remote.RemoteEnvironmentAuthorization, remote),
          Effect.provideService(ManagedRelay.ManagedRelayDpopSigner, {
            thumbprint: Effect.succeed("thumbprint-1"),
            createProof: () => Effect.succeed("proof"),
          }),
        );
        const profile = new HubProxyConnectionProfile({
          connectionId: "via-hub",
          environmentId: EnvironmentId.make("node"),
          label: "Node",
          hubEnvironmentId: ENVIRONMENT_ID,
          hubConnectionId: "relay",
          nodeId: "node",
        });
        const read = Effect.gen(function* () {
          const auth = yield* source.resolve(profile);
          return yield* requestHubProxyJson(auth, "node", "/snapshot", (value) =>
            Effect.succeed(value),
          );
        });
        expect(yield* read.pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "permission" },
        });
        // The server now consents, but an existing signed credential keeps its old scopes.
        expect(yield* read.pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "permission" },
        });
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(0);
        yield* Ref.set(harness.session, Option.none());
        yield* Ref.set(harness.session, Option.some({ accountId: "account-1" }));
        expect(yield* read).toEqual({ nodeId: "node", threads: [] });
        expect(yield* Ref.get(harness.bootstrapCalls)).toBe(1);
        const headers = harness.fetch.calls
          .filter(([url]) => String(url).endsWith("/snapshot"))
          .map(([, init]) => new Headers(init.headers).get("authorization"));
        expect(headers).toEqual([
          "DPoP cached-access-token",
          "DPoP cached-access-token",
          "DPoP privileged",
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(harness.layer, RpcHttp.layerRemoteHttpClient(harness.fetch.fetchFn)),
        ),
      );
    }),
);
