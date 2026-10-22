import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { enrollmentSecretName, SNAPSHOT_MAX_BYTES } from "./HubProxySessions.ts";
import {
  makeNodes,
  makeSecrets,
  makeSessions,
  makeSsh,
  readScopes,
  sshNode,
} from "./testFixtures.ts";

const responseWithBody = (
  request: HttpClientRequest.HttpClientRequest,
  body: Stream.Stream<Uint8Array>,
) => {
  const response = Object.create(
    HttpClientResponse.fromWeb(request, new Response()),
  ) as HttpClientResponse.HttpClientResponse;
  Object.defineProperty(response, "stream", { value: body });
  return response;
};

const linkedNode = {
  ...sshNode,
  routes: [{ kind: "linked" as const, baseUrl: "https://node.invalid" }],
};
const seed = (secrets: ReturnType<typeof makeSecrets>) =>
  secrets.service.set(
    enrollmentSecretName("node-1"),
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        nodeId: "node-1",
        baseUrl: "https://node.invalid",
        token: "linked-token",
        scopes: readScopes,
        expiresAt: null,
      }),
    ),
  );

it.effect("R1: a queued SSH open cannot adopt the generation after removal", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes();
    const ssh = makeSsh("http://node.invalid/");
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sessions = yield* makeSessions(
      nodes.service,
      {
        ...ssh.service,
        issueProxySession: (target, scopes) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(ssh.service.issueProxySession(target, scopes)),
          ),
      },
      makeSecrets().service,
    );
    yield* nodes.subscribed;
    const first = yield* sessions
      .open("node-1", readScopes)
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    const second = yield* sessions
      .open("node-1", readScopes)
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* nodes.replace(undefined);
    yield* sessions.revoked("node-1", 0);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(first)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unavailable" },
    });
    expect(yield* Fiber.join(second)).toMatchObject({
      _tag: "Failure",
      failure: {
        reason: "unavailable",
        message: "This node changed while the hub was connecting. Try again.",
      },
    });
    expect(ssh.issues).toHaveLength(1);
    expect(Option.isNone(yield* sessions.peek("node-1"))).toBe(true);
    expect(yield* sessions.isCurrent("node-1", 0)).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("R1: a linked secret read cannot adopt the generation after removal", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes(linkedNode);
    const secrets = makeSecrets();
    yield* seed(secrets);
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const sessions = yield* makeSessions(nodes.service, makeSsh("http://unused/").service, {
      ...secrets.service,
      get: (name) =>
        secrets.service.get(name).pipe(
          Effect.tap(() => Deferred.succeed(started, undefined)),
          Effect.tap(() => Deferred.await(release)),
        ),
    });
    yield* nodes.subscribed;
    const opened = yield* sessions
      .open("node-1", readScopes)
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* nodes.replace(undefined);
    yield* sessions.revoked("node-1", 0);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(opened)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unavailable" },
    });
  }).pipe(Effect.scoped),
);

it.effect.each(["unenroll", "remove", "replace route"] as const)(
  "R2: %s during the descriptor fetch fences the first enrollment",
  (change) =>
    Effect.gen(function* () {
      const nodes = yield* makeNodes(linkedNode);
      const secrets = makeSecrets();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let exchanges = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          if (request.url.endsWith("/.well-known/goat/environment")) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ environmentId: sshNode.environmentId }),
            );
          }
          exchanges += 1;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "old-enrollment",
              token_type: "Bearer",
              scope: "orchestration:read",
            }),
          );
        }),
      );
      const sessions = yield* makeSessions(
        nodes.service,
        makeSsh("http://unused/").service,
        secrets.service,
        client,
      );
      yield* nodes.subscribed;
      const enrolled = yield* sessions
        .enroll({ nodeId: "node-1", pairingUrl: "https://node.invalid/pair#token=pairing-secret" })
        .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      if (change === "unenroll") yield* sessions.unenroll("node-1");
      else {
        yield* nodes.replace(
          change === "remove"
            ? undefined
            : {
                ...linkedNode,
                routes: [{ kind: "linked", baseUrl: "https://replacement.invalid" }],
              },
        );
        yield* sessions.revoked("node-1", 0);
      }
      yield* Deferred.succeed(release, undefined);
      expect(yield* Fiber.join(enrolled)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "unavailable" },
      });
      expect(exchanges).toBe(0);
      expect(secrets.values.size).toBe(0);
      if (change === "unenroll")
        expect(yield* Effect.flip(sessions.open("node-1", readScopes))).toMatchObject({
          reason: "enrollment_required",
        });
    }).pipe(Effect.scoped),
);

it.effect("R4: retained snapshot limits count multibyte text in bytes", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes();
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://node.invalid/").service,
      makeSecrets().service,
    );
    const opened = yield* sessions.open("node-1", readScopes);
    yield* sessions.recordSnapshot(
      "node-1",
      "한".repeat(Math.floor(SNAPSHOT_MAX_BYTES / 3) + 1),
      opened.generation,
    );
    expect(Option.isNone(yield* sessions.snapshot("node-1"))).toBe(true);
  }).pipe(Effect.scoped),
);

it.effect("R4: a refresher aborts a chunked shell as soon as it crosses the byte cap", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes();
    const cancelled = yield* Deferred.make<void>();
    let pulled = 0;
    const body = Stream.range(1, 100).pipe(
      Stream.rechunk(1),
      Stream.map(() => {
        pulled += 1;
        return new Uint8Array(1024 * 1024);
      }),
      Stream.ensuring(Deferred.succeed(cancelled, undefined)),
    );
    const client = HttpClient.make((request) => Effect.succeed(responseWithBody(request, body)));
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://node.invalid/").service,
      makeSecrets().service,
      client,
    );
    const relayScope = yield* Scope.make();
    yield* sessions.trackRelay("node-1").pipe(Effect.provideService(Scope.Scope, relayScope));
    yield* Deferred.await(cancelled);
    expect(pulled).toBe(5);
    expect(Option.isNone(yield* sessions.snapshot("node-1"))).toBe(true);
    yield* Scope.close(relayScope, Exit.void);
  }).pipe(Effect.scoped),
);

it.effect("R4: the refresher deadline covers headers and a body that never ends", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes();
    const headers = yield* Deferred.make<void>();
    const releaseHeaders = yield* Deferred.make<void>();
    const reading = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(headers, undefined);
        yield* Deferred.await(releaseHeaders);
        return responseWithBody(
          request,
          Stream.never.pipe(
            Stream.onStart(Deferred.succeed(reading, undefined)),
            Stream.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
        );
      }),
    );
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://node.invalid/").service,
      makeSecrets().service,
      client,
    );
    const relayScope = yield* Scope.make();
    yield* sessions.trackRelay("node-1").pipe(Effect.provideService(Scope.Scope, relayScope));
    yield* Deferred.await(headers);
    yield* TestClock.adjust("15 seconds");
    yield* Deferred.succeed(releaseHeaders, undefined);
    yield* Deferred.await(reading);
    yield* TestClock.adjust("5 seconds");
    yield* Deferred.await(cancelled);
    expect(Option.isNone(yield* sessions.snapshot("node-1"))).toBe(true);
    yield* Scope.close(relayScope, Exit.void);
  }).pipe(Effect.scoped),
);

it.effect("N2: a token answer that never ends times out and frees the node for unenrollment", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes(linkedNode);
    const secrets = makeSecrets();
    const tokenRequested = yield* Deferred.make<void>();
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url.endsWith("/.well-known/goat/environment"))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ environmentId: sshNode.environmentId }),
          );
        yield* Deferred.succeed(tokenRequested, undefined);
        // Headers arrive at once; the body trickles one byte and never finishes.
        const trickle = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
        });
        return HttpClientResponse.fromWeb(request, new Response(trickle, { status: 200 }));
      }),
    );
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://unused/").service,
      secrets.service,
      client,
    );
    yield* nodes.subscribed;
    const enrolled = yield* sessions
      .enroll({ nodeId: "node-1", pairingUrl: "https://node.invalid/pair#token=pairing-secret" })
      .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(tokenRequested);
    yield* TestClock.adjust("21 seconds");
    expect(yield* Fiber.join(enrolled)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "unavailable" },
    });
    // The permit is free again, so removing access is never stuck behind the node.
    expect(yield* sessions.unenroll("node-1")).toBe(false);
    expect(secrets.values.size).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("N2: an oversized descriptor is refused without decoding it", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes(linkedNode);
    const secrets = makeSecrets();
    let exchanges = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        if (!request.url.endsWith("/.well-known/goat/environment")) exchanges += 1;
        return HttpClientResponse.fromWeb(
          request,
          new Response(`{"environmentId":"${"x".repeat(70 * 1024)}"}`, { status: 200 }),
        );
      }),
    );
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://unused/").service,
      secrets.service,
      client,
    );
    yield* nodes.subscribed;
    expect(
      yield* Effect.flip(
        sessions.enroll({
          nodeId: "node-1",
          pairingUrl: "https://node.invalid/pair#token=pairing-secret",
        }),
      ),
    ).toMatchObject({ reason: "unavailable" });
    expect(exchanges).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("R3-S1: a refused token exchange releases its unread body", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes(linkedNode);
    const secrets = makeSecrets();
    const cancelled = yield* Deferred.make<void>();
    // Like fetch, aborting the request's signal is what releases an unread body.
    const client = HttpClient.make((request, _url, signal) =>
      Effect.sync(() => {
        if (request.url.endsWith("/.well-known/goat/environment"))
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ environmentId: sshNode.environmentId }),
          );
        signal.addEventListener("abort", () => {
          Deferred.doneUnsafe(cancelled, Effect.void);
        });
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
        });
        return HttpClientResponse.fromWeb(request, new Response(body, { status: 403 }));
      }),
    );
    const sessions = yield* makeSessions(
      nodes.service,
      makeSsh("http://unused/").service,
      secrets.service,
      client,
    );
    yield* nodes.subscribed;
    expect(
      yield* Effect.flip(
        sessions.enroll({
          nodeId: "node-1",
          pairingUrl: "https://node.invalid/pair#token=pairing-secret",
        }),
      ),
    ).toMatchObject({ reason: "refused" });
    yield* Deferred.await(cancelled);
    expect(yield* sessions.unenroll("node-1")).toBe(false);
  }).pipe(Effect.scoped),
);
