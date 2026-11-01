import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Client from "./MemoryHubClient.ts";
import { sourceReadLocatorDigest } from "./MemoryOwnerSourceReader.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";

const space = M.MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
const environment = M.EnvironmentId.make("synthetic-hub");
const credential = "c".repeat(43);
const connection: Client.HubConnection = {
  mode: "member",
  endpoint: M.MemoryHubEndpoint.make("https://hub.invalid"),
  hubEnvironmentId: environment,
  memorySpaceId: space,
  secretName: "memory-hub-test",
  epoch: 1,
};
const descriptor = {
  environmentId: environment,
  label: "Synthetic hub",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1",
  capabilities: { memoryHubProtocolVersion: 1 },
};
const input = Schema.decodeUnknownSync(M.MemoryHubSourceReadCollectInput)({
  protocolVersion: 1,
  memorySpaceId: space,
  limit: 32,
});
const live = Client.layer.pipe(
  Layer.provideMerge(Settings.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "goat-hub-client-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const seed = Effect.gen(function* () {
  const transitions = yield* Settings.MemoryHubSettingsTransitions;
  const { epoch: _epoch, ...settings } = connection;
  yield* transitions.applyMemoryHubTransition(
    {
      requestId: M.MemoryOperationId.make("00000000-0000-4000-8000-000000000098"),
      expectedVersion: 0,
      settings,
    },
    Effect.void,
  );
  const secrets = yield* Secrets.ServerSecretStore;
  yield* secrets.set(connection.secretName, new TextEncoder().encode(credential));
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

it.effect("preflight identity/protocol/redirect failures never forward a credential", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    for (const response of [
      json({ ...descriptor, environmentId: "wrong-hub" }),
      json({ ...descriptor, capabilities: {} }),
      new Response(null, { status: 302, headers: { location: "https://hub.invalid/next" } }),
    ]) {
      const calls: RequestInit[] = [];
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        calls.push(init ?? {});
        return response;
      };
      const result = yield* Effect.result(
        client
          .collectSourceReads(connection, input)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(new Headers(calls[0]?.headers).get("authorization"), null);
      assert.strictEqual(calls[0]?.redirect, "manual");
      assert.strictEqual(calls[0]?.credentials, "omit");
    }
  }).pipe(Effect.provide(live)),
);

it.effect("missing hub advertisement stops before reading the credential or posting", () =>
  Effect.gen(function* () {
    yield* seed;
    const secrets = yield* Secrets.ServerSecretStore;
    let credentialReads = 0;
    const observedSecrets = Secrets.ServerSecretStore.of({
      ...secrets,
      get: (name) => {
        if (name === connection.secretName) credentialReads++;
        return secrets.get(name);
      },
    });
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls.push(init?.method ?? "GET");
      return json({ ...descriptor, capabilities: {} });
    };
    const result = yield* Effect.gen(function* () {
      const client = yield* Client.MemoryHubClient;
      return yield* Effect.result(client.collectSourceReads(connection, input));
    }).pipe(
      Effect.provide(Layer.fresh(Client.layer)),
      Effect.provideService(Secrets.ServerSecretStore, observedSecrets),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(result.failure._tag, "MemoryHubError");
      if (result.failure._tag === "MemoryHubError")
        assert.strictEqual(result.failure.code, "unsupported_protocol");
    }
    assert.strictEqual(credentialReads, 0);
    assert.deepStrictEqual(calls, ["GET"]);
  }).pipe(Effect.provide(live)),
);

it.effect("401 and 403 remain distinct and are never retried", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    for (const status of [401, 403]) {
      let postCount = 0;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        if (init?.method === "GET") return json(descriptor);
        postCount++;
        assert.strictEqual(new Headers(init?.headers).get("authorization"), `Bearer ${credential}`);
        return json({}, status);
      };
      const result = yield* Effect.result(
        client
          .collectSourceReads(connection, input)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(
          result.failure._tag,
          status === 401 ? "MemoryHubUnauthorizedError" : "MemoryHubForbiddenError",
        );
      assert.strictEqual(postCount, 1);
    }
  }).pipe(Effect.provide(live)),
);

it.effect("unavailable retries identical input after clock-driven backoff", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const failed = yield* Deferred.make<void>();
    const bodies: unknown[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") return json(descriptor);
      bodies.push(init?.body);
      return bodies.length === 1 ? json({}, 503) : json({ requests: [] });
    };
    const program = client.collectSourceReads(connection, input);
    // Network milestone, then TestClock drives the retry schedule; no wall-clock sleep.
    const markedFetch: typeof globalThis.fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (response.status === 503) Deferred.doneUnsafe(failed, Effect.void);
      return response;
    };
    const fiber = yield* program.pipe(
      Effect.provideService(FetchHttpClient.Fetch, markedFetch),
      Effect.forkChild,
    );
    yield* Deferred.await(failed);
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(yield* Fiber.join(fiber), { requests: [] });
    assert.strictEqual(bodies.length, 2);
    assert.deepStrictEqual(bodies[0], bodies[1]);
  }).pipe(Effect.provide(live)),
);

it.effect("late old-epoch responses are discarded after settings change", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const transitions = yield* Settings.MemoryHubSettingsTransitions;
    const posted = yield* Deferred.make<void>();
    const release = Promise.withResolvers<void>();
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") return json(descriptor);
      Deferred.doneUnsafe(posted, Effect.void);
      await release.promise;
      return json({ requests: [] });
    };
    const fiber = yield* Effect.result(client.collectSourceReads(connection, input)).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.forkChild,
    );
    yield* Deferred.await(posted);
    yield* transitions.applyMemoryHubTransition(
      {
        requestId: M.MemoryOperationId.make("00000000-0000-4000-8000-000000000099"),
        expectedVersion: 1,
        settings: { mode: "disabled" },
      },
      Effect.void,
    );
    yield* Effect.sync(() => release.resolve());
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure" && result.failure._tag === "MemoryHubError")
      assert.strictEqual(result.failure.code, "fenced");
  }).pipe(Effect.provide(live)),
);

it.effect("unsupported route, bad schema, and oversized response stop without retry", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    for (const [response, code] of [
      [json({}, 404), "route_unavailable"],
      [json({ _tag: "MemoryHubError", code: "hub_disabled" }, 503), "hub_disabled"],
      [json({ requests: [], extra: true }), "invalid_output"],
      [new Response("x".repeat(1048577)), "payload_too_large"],
    ] as const) {
      let posts = 0;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        if (init?.method === "GET") return json(descriptor);
        posts++;
        return response;
      };
      const result = yield* Effect.result(
        client
          .collectSourceReads(connection, input)
          .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "MemoryHubError")
        assert.strictEqual(result.failure.code, code);
      assert.strictEqual(posts, 1);
    }
  }).pipe(Effect.provide(live)),
);

it.effect("the total request deadline interrupts stalled network work", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const posted = yield* Deferred.make<void>();
    let aborted = false;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") return json(descriptor);
      Deferred.doneUnsafe(posted, Effect.void);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("synthetic abort"));
        });
      });
    };
    const fiber = yield* Effect.result(client.collectSourceReads(connection, input)).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.forkChild,
    );
    yield* Deferred.await(posted);
    yield* TestClock.adjust("15 seconds");
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    assert.isTrue(aborted);
  }).pipe(Effect.provide(live)),
);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hub = { protocolVersion: 1, memorySpaceId: space };
const leaseKey = {
  ...hub,
  memoryId: id(2),
  conflictId: id(8),
  holderEnvironmentId: "member",
  attemptId: id(4),
};
const selection = { instanceId: "codex", model: "synthetic" };
const revision = {
  memorySpaceId: space,
  memoryId: id(2),
  revisionId: id(3),
  operationId: id(4),
  parents: [id(5), id(6)],
  scope: { kind: "user" },
  payloadRef: id(3),
  assertionKind: "inference",
  provenance: { environmentId: "member" },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
};
const apply = Schema.decodeUnknownSync(M.MemoryHubApplyResolutionInput)({
  ...hub,
  holderEnvironmentId: "member",
  attemptId: id(4),
  operation: {
    ...hub,
    memoryId: id(2),
    operationId: id(4),
    originEnvironmentId: "member",
    expectedHeads: [id(5), id(6)],
    kind: "resolve",
    revision,
    payload: { text: "synthetic result", evidence: [], derivedFromMemoryRevisions: [] },
    resolution: {
      resolutionId: id(7),
      memorySpaceId: space,
      memoryId: id(2),
      inputRevisionIds: [id(5), id(6)],
      inputPayloadRefs: [id(5), id(6)],
      judgmentRef: id(7),
      requestedModelSelection: selection,
      effectiveProvider: "codex",
      effectiveModel: "synthetic",
      resolvingEnvironmentId: "member",
      fencingToken: 7,
      resultRevisionId: id(3),
      appliedAtUtc: "2026-10-14T00:00:00.000Z",
      revertDeadlineUtc: "2026-11-13T00:00:00.000Z",
    },
    resolutionPayload: { resolutionId: id(7), judgment: "Synthetic decision" },
    conflictId: id(8),
    fencingToken: 7,
  },
});
const join = Schema.decodeUnknownSync(M.MemoryHubJoinInput)({ ...hub, environmentId: "member" });
const push = Schema.decodeUnknownSync(M.MemoryHubPushInput)({
  ...hub,
  environmentId: "member",
  operations: [],
});
const pull = Schema.decodeUnknownSync(M.MemoryHubPullInput)({
  ...hub,
  environmentId: "member",
  afterSequence: 0,
});
const claim = Schema.decodeUnknownSync(M.MemoryHubClaimInput)({
  ...leaseKey,
  conflictHeadSet: [id(5), id(6)],
  frozenDefaultModelSelection: selection,
});
const renew = Schema.decodeUnknownSync(M.MemoryHubRenewInput)({ ...leaseKey, fencingToken: 7 });
const release = Schema.decodeUnknownSync(M.MemoryHubReleaseInput)({ ...leaseKey, fencingToken: 7 });
const source = Schema.decodeUnknownSync(M.MemoryHubSourceReadRequestInput)({
  ...hub,
  requestId: id(11),
  memoryId: id(2),
  sourceThread: { environmentId: "owner", threadId: "thread" },
  sourceWatermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 2 },
  messageIds: ["m1"],
  authorizedScopes: ["memory:read", "orchestration:read"],
});
const respond = Schema.decodeUnknownSync(M.MemoryHubSourceReadRespondInput)({
  ...hub,
  requestId: id(11),
  outcome: { kind: "denied", requiredPermission: "orchestration:read" },
});
const sourceResult = Schema.decodeUnknownSync(M.MemoryHubSourceReadResultInput)({
  ...hub,
  requestId: id(11),
});

it.effect("every typed hub call refuses an unavailable route without credential fallback", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const calls: Effect.Effect<unknown, Client.HubClientFailure>[] = [
      client.join(connection, join),
      client.push(connection, push),
      client.pull(connection, pull),
      client.claim(connection, claim),
      client.renew(connection, renew),
      client.applyResolution(connection, apply),
      client.release(connection, release),
      client.requestSourceRead(connection, source),
      client.collectSourceReads(connection, input),
      client.respondSourceRead(connection, respond),
      client.resultSourceRead(connection, sourceResult),
    ];
    const destinations: string[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (init?.method === "GET") return json(descriptor);
      destinations.push(new URL(String(url)).pathname);
      return json({}, 404);
    };
    for (const call of calls) {
      const result = yield* Effect.result(
        call.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure" && result.failure._tag === "MemoryHubError")
        assert.strictEqual(result.failure.code, "route_unavailable");
    }
    assert.deepStrictEqual(destinations, Object.values(M.MEMORY_HUB_PATHS));
  }).pipe(Effect.provide(live)),
);

it.effect("repeated transient failure stops after two retries", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const milestones = yield* Effect.forEach([0, 1, 2], () => Deferred.make<void>());
    let posts = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") return json(descriptor);
      const milestone = milestones[posts++];
      if (milestone) Deferred.doneUnsafe(milestone, Effect.void);
      return json({}, 503);
    };
    const fiber = yield* Effect.result(client.collectSourceReads(connection, input)).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.forkChild,
    );
    yield* Deferred.await(milestones[0]!);
    yield* TestClock.adjust("250 millis");
    yield* Deferred.await(milestones[1]!);
    yield* TestClock.adjust("500 millis");
    yield* Deferred.await(milestones[2]!);
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(posts, 3);
  }).pipe(Effect.provide(live)),
);

it.effect("a configured loopback HTTP hub passes the same pinned preflight", () =>
  Effect.gen(function* () {
    yield* seed;
    const transitions = yield* Settings.MemoryHubSettingsTransitions;
    const { epoch: _epoch, ...configured } = connection;
    const settings = {
      ...configured,
      endpoint: M.MemoryHubEndpoint.make("http://127.0.0.1:12345"),
    };
    yield* transitions.applyMemoryHubTransition(
      { requestId: M.MemoryOperationId.make(id(97)), expectedVersion: 1, settings },
      Effect.void,
    );
    const client = yield* Client.MemoryHubClient;
    const fetch: typeof globalThis.fetch = async (_url, init) =>
      init?.method === "GET" ? json(descriptor) : json({ requests: [] });
    assert.deepStrictEqual(
      yield* client
        .collectSourceReads({ ...settings, epoch: 2 }, input)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      { requests: [] },
    );
  }).pipe(Effect.provide(live)),
);

it.effect.each(["missing", "digest", "locator"] as const)(
  "refuses a source request reply with %s stamp integrity",
  (fault) =>
    Effect.gen(function* () {
      yield* seed;
      const client = yield* Client.MemoryHubClient;
      const { protocolVersion: _version, ...fields } = source;
      const stamp = {
        requesterCredentialVersion: 1,
        locatorDigest: sourceReadLocatorDigest(source),
      };
      const request = {
        ...fields,
        requesterEnvironmentId: M.EnvironmentId.make("requester"),
        expiresAtHubTime: "1970-01-01T00:01:15.000Z",
        ...(fault === "missing"
          ? {}
          : { stamp: fault === "digest" ? { ...stamp, locatorDigest: "f".repeat(64) } : stamp }),
        ...(fault === "locator" ? { limit: 1 } : {}),
      };
      const fetch: typeof globalThis.fetch = async (_url, init) =>
        init?.method === "GET" ? json(descriptor) : json({ request });
      const result = yield* client
        .requestSourceRead(connection, source)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip);
      assert.strictEqual(result._tag, "MemoryHubError");
      if (result._tag === "MemoryHubError") assert.strictEqual(result.code, "invalid_output");
    }).pipe(Effect.provide(live)),
);

it.effect.each(["normal arm", "wrong space", "wrong requester", "wrong epoch"] as const)(
  "refuses revoke acknowledgement: %s",
  (fault) =>
    Effect.gen(function* () {
      yield* seed;
      const client = yield* Client.MemoryHubClient;
      const input: M.MemoryHubSourceReadRevokeInput = {
        protocolVersion: 1,
        kind: "revoke",
        memorySpaceId: space,
        requesterEnvironmentId: M.EnvironmentId.make("requester"),
        ownerPolicyEpoch: 2,
      };
      const ack = {
        memorySpaceId: fault === "wrong space" ? M.MemorySpaceId.make(id(90)) : space,
        ownerEnvironmentId: M.EnvironmentId.make("owner"),
        requesterEnvironmentId:
          fault === "wrong requester"
            ? M.EnvironmentId.make("other")
            : input.requesterEnvironmentId,
        removalEpoch: fault === "wrong epoch" ? 1 : 2,
        revokedThroughEpoch: 2,
      };
      const fetch: typeof globalThis.fetch = async (_url, init) =>
        init?.method === "GET"
          ? json(descriptor)
          : json(
              fault === "normal arm"
                ? { kind: "normal", accepted: true }
                : { kind: "revoke", accepted: true, ack },
            );
      const result = yield* client
        .respondSourceRead(connection, input)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.flip);
      assert.strictEqual(result._tag, "MemoryHubError");
      if (result._tag === "MemoryHubError") assert.strictEqual(result.code, "invalid_output");
    }).pipe(Effect.provide(live)),
);

it.effect("revalidates source after descriptor preparation and on every retry", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const failed = yield* Deferred.make<void>();
    let descriptors = 0;
    let validations = 0;
    const outcomes: string[] = [];
    const response: M.MemoryHubSourceReadRespondInput = {
      protocolVersion: 1,
      kind: "normal",
      memorySpaceId: space,
      ownerPolicyEpoch: 1,
      requestId: M.MemorySourceReadRequestId.make("00000000-0000-4000-8000-000000000088"),
      outcome: {
        kind: "available",
        page: {
          sourceThread: { environmentId: environment, threadId: M.ThreadId.make("fixture") },
          watermark: {
            fromEventId: M.EventId.make("fixture-event"),
            toEventId: M.EventId.make("fixture-event"),
            throughSequence: 1,
          },
          messages: [],
          nextCursor: null,
        },
      },
    };
    const prepare = Effect.sync(() => {
      validations++;
      assert.strictEqual(validations, descriptors);
      return validations === 1
        ? response
        : {
            ...response,
            outcome: { kind: "unavailable" as const, code: "source_invalidated" as const },
          };
    });
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      if (init?.method === "GET") {
        descriptors++;
        return json(descriptor);
      }
      outcomes.push(JSON.parse(String(init?.body)).outcome.kind);
      if (outcomes.length === 1) {
        Deferred.doneUnsafe(failed, Effect.void);
        return json({}, 503);
      }
      return json({ kind: "normal", accepted: true });
    };
    const fiber = yield* client
      .respondSourceRead(connection, response, prepare)
      .pipe(Effect.provideService(FetchHttpClient.Fetch, fetch), Effect.forkChild);
    yield* Deferred.await(failed);
    yield* TestClock.adjust("250 millis");
    yield* Fiber.join(fiber);
    assert.strictEqual(validations, 2);
    assert.deepStrictEqual(outcomes, ["available", "unavailable"]);
  }).pipe(Effect.provide(live)),
);

it.effect("v1 pull requires the lineage field and rejects the old checkpoint codec", () =>
  Effect.gen(function* () {
    yield* seed;
    const client = yield* Client.MemoryHubClient;
    const page: M.MemoryHubCheckpointPage = {
      memorySpaceId: space,
      checkpointSequence: 0,
      retentionFloor: 0,
      causalBoundary: { checkpointSequence: 0, boundaryId: "synthetic-boundary" },
      pageOrdinal: 0,
      items: [],
      revisions: [],
      tombstones: [],
      conflicts: [],
      resolutions: [],
      compactReceipts: [],
      identities: [],
      fences: [],
      suppressions: [],
      importLineage: [],
      nextCursor: null,
      bootstrapComplete: true,
    };
    const { importLineage: _lineage, ...oldPage } = page;
    for (const [checkpoint, valid] of [
      [page, true],
      [oldPage, false],
    ] as const) {
      const fetch: typeof globalThis.fetch = async (_url, init) =>
        init?.method === "POST"
          ? json({ highWatermark: 0, throughSequence: 0, hasMore: false, entries: [], checkpoint })
          : json(descriptor);
      const result = yield* Effect.result(
        client.pull(connection, pull).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
      );
      assert.strictEqual(result._tag, valid ? "Success" : "Failure");
    }
  }).pipe(Effect.provide(live)),
);

it("treats a rebound Hub as a different connection even when the epoch is unchanged", () => {
  const binding = {
    mode: "member" as const,
    memorySpaceId: space,
    hubEnvironmentId: environment,
    endpoint: M.MemoryHubEndpoint.make("https://hub.invalid"),
    secretName: "memory-hub-a",
  };
  const connection = { ...binding, epoch: 3 };
  assert.isTrue(
    Client.isCurrentConnection({ memoryHub: binding, memoryHubVersion: 3 }, connection),
  );
  // External settings may change the binding without bumping the epoch; a fence raised
  // locally for that change must not pass as the Hub ending the lease.
  for (const memoryHub of [
    { ...binding, secretName: "memory-hub-b" },
    { ...binding, endpoint: M.MemoryHubEndpoint.make("https://other.invalid") },
    { ...binding, memorySpaceId: null },
    { mode: "disabled" as const },
  ])
    assert.isFalse(Client.isCurrentConnection({ memoryHub, memoryHubVersion: 3 }, connection));
  assert.isFalse(
    Client.isCurrentConnection({ memoryHub: binding, memoryHubVersion: 4 }, connection),
  );
});
