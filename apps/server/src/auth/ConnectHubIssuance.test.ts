import { expect, it } from "@effect/vitest";
import type { ServerSettingsError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Config from "../config.ts";
import * as Runtime from "./ConnectHubRuntime.testkit.ts";

it.effect.each([
  { phase: "mint", first: "issuance" },
  { phase: "exchange", first: "issuance" },
  { phase: "mint", first: "withdrawal" },
  { phase: "exchange", first: "withdrawal" },
] as const)("$phase versus withdrawal serializes with $first first", ({ phase, first }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* Config.ServerConfig;
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const attempted = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    let armed = false;
    const pause = Deferred.succeed(reached, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
    );
    const watch = yield* Runtime.watcher;
    const runtime = yield* Runtime.open({
      access: (access) => ({
        ...access,
        withPolicy: (use) =>
          Effect.suspend(() =>
            armed && first === "withdrawal" ? Deferred.succeed(attempted, undefined) : Effect.void,
          ).pipe(Effect.andThen(access.withPolicy(use))),
        commitPolicy: (allowed, commit) =>
          Effect.suspend(() =>
            armed && first === "issuance" ? Deferred.succeed(attempted, undefined) : Effect.void,
          ).pipe(Effect.andThen(access.commitPolicy(allowed, commit))),
      }),
      fs: {
        ...watch.fs,
        rename: (from, to) =>
          fs
            .rename(from, to)
            .pipe(
              Effect.tap(() =>
                armed && first === "withdrawal" && to === config.settingsPath ? pause : Effect.void,
              ),
            ),
      },
      grants: (store) => ({
        ...store,
        issueOneTimeToken: (input) =>
          Effect.suspend(() =>
            armed && first === "issuance" && phase === "mint" ? pause : Effect.void,
          ).pipe(Effect.andThen(store.issueOneTimeToken(input))),
      }),
      sessions: (store) => ({
        ...store,
        issue: (input) =>
          Effect.suspend(() =>
            armed && first === "issuance" && phase === "exchange" ? pause : Effect.void,
          ).pipe(Effect.andThen(store.issue(input))),
      }),
    });
    yield* runtime.auth.setCloudLinkTrust("test-account");
    yield* runtime.settings.start;
    yield* runtime.settings.updateSettings({
      hub: { enabled: true, connectDevicesHubProxy: true },
    });
    const generation = (yield* runtime.access.current).generation;
    const initial = yield* runtime.auth.createCloudConnectPairingLink({
      proofKeyThumbprint: "key",
    });
    const mint = runtime.auth.createCloudConnectPairingLink({ proofKeyThumbprint: "key" });
    const exchange = (credential: string) =>
      runtime.auth.exchangeBootstrapCredentialForAccessToken(
        credential,
        undefined,
        { deviceType: "mobile" },
        { proofKeyThumbprint: "key" },
      );
    let minted: Effect.Success<typeof mint> | undefined;
    let exchanged: Effect.Success<ReturnType<typeof exchange>> | undefined;
    const issuance =
      phase === "mint"
        ? mint.pipe(
            Effect.tap((grant) =>
              Effect.sync(() => {
                minted = grant;
              }),
            ),
            Effect.asVoid,
          )
        : exchange(initial.credential).pipe(
            Effect.tap((token) =>
              Effect.sync(() => {
                exchanged = token;
              }),
            ),
            Effect.asVoid,
          );
    const off: Effect.Effect<void, Effect.Error<typeof issuance> | ServerSettingsError> =
      runtime.settings
        .updateSettings({ hub: { connectDevicesHubProxy: false } })
        .pipe(Effect.asVoid);
    armed = true;
    const leading = yield* (first === "issuance" ? issuance : off).pipe(
      Effect.result,
      Effect.forkScoped,
    );
    yield* Deferred.await(reached);
    const trailing = yield* (first === "issuance" ? off : issuance).pipe(
      Effect.result,
      Effect.tap(() => Deferred.succeed(finished, undefined)),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.await(attempted);
    expect(yield* Deferred.isDone(finished)).toBe(false);
    if (first === "issuance") expect((yield* runtime.access.current).generation).toBe(generation);
    else expect((yield* runtime.access.current).allowed).toBe(false);
    yield* Deferred.succeed(release, undefined);
    const leadingResult = yield* Fiber.join(leading);
    const trailingResult = yield* Fiber.join(trailing);
    expect(leadingResult._tag).toBe("Success");
    expect(trailingResult._tag).toBe(
      first === "withdrawal" && phase === "exchange" ? "Failure" : "Success",
    );
    expect((yield* runtime.access.current).generation).toBeGreaterThan(generation);
    expect((yield* runtime.settings.getSettings).hub.connectDevicesHubProxy).toBe(false);
    if (first === "issuance" && minted) {
      expect(yield* exchange(minted.credential).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
      });
    }
    if (first === "issuance" && exchanged) {
      const token = exchanged.access_token;
      const request = HttpServerRequest.fromWeb(
        new Request("http://hub.test/api/auth/session", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(
        yield* runtime.auth.authenticateHttpRequest(request).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
    }
    if (first === "withdrawal" && minted) {
      expect(minted.scopes).not.toContain("hub:proxy");
      expect(
        (yield* runtime.sessions.verify((yield* exchange(minted.credential)).access_token)).scopes,
      ).not.toContain("hub:proxy");
    }
    armed = false;
    const after = yield* mint;
    expect(after.scopes).not.toContain("hub:proxy");
    const standard = yield* exchange(after.credential);
    expect((yield* runtime.sessions.verify(standard.access_token)).scopes).not.toContain(
      "hub:proxy",
    );
  }).pipe(Effect.scoped, Effect.provide(Runtime.storage)),
);
