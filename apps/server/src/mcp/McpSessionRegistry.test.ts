import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as MemoryFixture from "./toolkits/memory/handlers.testkit.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.grantedScopes).toEqual([]);
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      new Set(["preview", "orchestration", "worktree", "pull-requests"]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual([
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* capabilitiesOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
  }),
);

// regression: #3114 use bound host for MCP endpoint
it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect(
  "epoch drift, unready policy, ended callers and revoked handles withdraw memory authority",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1000);
      let current: McpSessionRegistry.McpMemoryPolicy | undefined = {
        grant: "read_write",
        policyEpoch: 1,
      };
      let live = false;
      const issue = () =>
        registry.issue({
          threadId: ThreadId.make("thread-memory-epochs"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          grantedScopes: ["memory:read", "memory:write"],
          memoryPolicy: current!,
          readCurrentPolicy: () => Effect.sync(() => current),
          isLiveCaller: Effect.sync(() => live),
        });
      const first = yield* issue();
      const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const scope = yield* registry.resolve(token);
      expect(scope).toBeDefined();
      expect((yield* scope!.reauthorize!(["memory:read"]).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      live = true;
      yield* scope!.reauthorize!(["memory:read"]);
      const withoutMemory = (
        resolved: McpInvocationContext.McpThreadInvocationScope | undefined,
      ) => {
        // The credential outlives the policy change; only its memory authority ends.
        expect(resolved?.thread.threadId).toBe(ThreadId.make("thread-memory-epochs"));
        expect(resolved?.grantedScopes).toEqual([]);
        expect(resolved?.memoryPolicy?.grant).toBe("none");
      };
      current = undefined;
      withoutMemory(yield* registry.resolve(token));
      expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toBeUndefined();
      current = { grant: "read_write", policyEpoch: 4 };
      // The intermediate stream epochs need not be observed: the latest Ref is authoritative.
      withoutMemory(yield* registry.resolve(token));
      expect((yield* scope!.reauthorize!(["memory:write"]).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      const last = yield* issue();
      expect(yield* registry.currentMemoryPolicy!(last.config.providerSessionId)).toEqual(current);
      yield* registry.revokeProviderSession(last.config.providerSessionId);
      expect(yield* registry.currentMemoryPolicy!(last.config.providerSessionId)).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("only a trusted touch restores an expired token with its original scope", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const scope = yield* registry.resolve(token);
    expect(scope).toBeDefined();

    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
    const otherThreadId = ThreadId.make("thread-active");
    const other = yield* registry.issue({
      threadId: otherThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    yield* registry.touch(otherThreadId);
    expect(
      (yield* registry.resolve(other.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .threadId,
    ).toBe(otherThreadId);
    expect(yield* registry.resolve("unknown-token")).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();

    yield* registry.touch(threadId);
    expect(yield* registry.resolve(token)).toEqual(scope);
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("credential ID lookup follows refresh, thread revocation and revokeAll", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const policy = { grant: "read_write" as const, policyEpoch: 1 };
    const threadId = ThreadId.make("indexed-memory-credential");
    const issue = () =>
      registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        memoryPolicy: policy,
        readCurrentPolicy: () => Effect.succeed(policy),
        isLiveCaller: Effect.succeed(true),
      });
    const first = yield* issue();
    const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 100;
    expect(yield* registry.resolve(token)).toBeDefined();
    timestamp += 100;
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toEqual(policy);
    yield* registry.touch(threadId);
    timestamp += 100;
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toEqual(policy);
    yield* registry.revokeThread(threadId);
    expect(yield* registry.currentMemoryPolicy!(first.config.providerSessionId)).toBeUndefined();
    expect(yield* registry.resolve(token)).toBeUndefined();
    const second = yield* issue();
    expect(yield* registry.currentMemoryPolicy!(second.config.providerSessionId)).toEqual(policy);
    yield* registry.revokeAll;
    expect(yield* registry.currentMemoryPolicy!(second.config.providerSessionId)).toBeUndefined();
    expect(
      yield* registry.resolve(second.config.authorizationHeader.replace(/^Bearer\s+/, "")),
    ).toBeUndefined();
  }),
);

it.effect.each([
  "memoryPolicy",
  "readCurrentPolicy",
  "isLiveCaller",
  "all",
  "unready",
  "ended",
] as const)(
  "actual read toolkit refuses incomplete or inactive registry authority: %s",
  (missing) =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1000);
      let ready = true;
      let live = true;
      const policy = { grant: "read" as const, policyEpoch: 1 };
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-memory-missing"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["memory"]),
        grantedScopes: ["memory:read"],
        ...(missing === "memoryPolicy" || missing === "all" ? {} : { memoryPolicy: policy }),
        ...(missing === "readCurrentPolicy" || missing === "all"
          ? {}
          : {
              readCurrentPolicy: () => Effect.sync(() => (ready ? policy : undefined)),
            }),
        ...(missing === "isLiveCaller" || missing === "all"
          ? {}
          : {
              isLiveCaller: Effect.sync(() => live),
            }),
      });
      const scope = yield* registry.resolve(
        issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      expect(scope).toBeDefined();
      if (missing === "unready") ready = false;
      if (missing === "ended") live = false;
      const result = yield* MemoryFixture.call(
        "memory_list",
        {
          memorySpaceId: MemoryFixture.space,
          includeQuarantined: false,
        },
        scope!,
      );
      expect(result.result.isError).toBe(true);
      expect(result.body).toMatchObject({ code: "unavailable" });
      if (["memoryPolicy", "readCurrentPolicy", "isLiveCaller", "all", "unready"].includes(missing))
        expect(
          yield* registry.currentMemoryPolicy!(issued.config.providerSessionId),
        ).toBeUndefined();
    }).pipe(Effect.provide(MemoryFixture.layer)),
);

it.effect("renews authority under the same token and fences permits taken before the change", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-renew");
    const policy = { grant: "read_write" as const, policyEpoch: 1 };
    const request = {
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      grantedScopes: ["memory:read", "memory:write"] as const,
      memoryPolicy: policy,
      readCurrentPolicy: () => Effect.succeed(policy),
      isLiveCaller: Effect.succeed(true),
    };
    const first = yield* registry.issue(request);
    const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const before = yield* registry.resolve(token);
    yield* before!.reauthorize!(["memory:write"]);

    const renewed = yield* registry.issue({
      ...request,
      grantedScopes: ["memory:read"],
      memoryPolicy: { grant: "read", policyEpoch: 1 },
      readCurrentPolicy: () => Effect.succeed({ grant: "read" as const, policyEpoch: 1 }),
      readOnly: true,
      renew: {
        authorizationHeader: first.config.authorizationHeader,
        providerSessionId: first.config.providerSessionId,
      },
    });
    expect(renewed.renewed).toBe(true);
    expect(renewed.config.authorizationHeader).toBe(first.config.authorizationHeader);
    expect(renewed.config.providerSessionId).toBe(first.config.providerSessionId);
    expect(renewed.config.credentialGeneration).toBe((first.config.credentialGeneration ?? 0) + 1);
    const after = yield* registry.resolve(token);
    expect(after?.grantedScopes).toEqual(["memory:read"]);
    expect(after?.readOnly).toBe(true);
    // A permit from before the change cannot borrow the replacement's authority.
    expect((yield* before!.reauthorize!(["memory:read"]).pipe(Effect.flip))._tag).toBe(
      "EnvironmentAuthorizationError",
    );
    yield* after!.reauthorize!(["memory:read"]);
    expect((yield* after!.reauthorize!(["memory:write"]).pipe(Effect.flip))._tag).toBe(
      "EnvironmentAuthorizationError",
    );
  }),
);

it.effect("never renews a revoked credential and refuses a mismatched renewal", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const threadId = ThreadId.make("thread-revoked-renewal");
    const request = { threadId, providerInstanceId: ProviderInstanceId.make("codex") };
    const first = yield* registry.issue(request);
    const renew = {
      authorizationHeader: first.config.authorizationHeader,
      providerSessionId: first.config.providerSessionId,
    };
    const otherThread = yield* registry.issue({
      ...request,
      threadId: ThreadId.make("thread-other"),
      renew,
    });
    expect(otherThread.renewed).toBe(false);
    expect(otherThread.config.authorizationHeader).not.toBe(first.config.authorizationHeader);

    yield* registry.revokeProviderSession(first.config.providerSessionId);
    const afterRevoke = yield* registry.issue({ ...request, renew });
    expect(afterRevoke.renewed).toBe(false);
    expect(afterRevoke.config.authorizationHeader).not.toBe(first.config.authorizationHeader);
    const token = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect(yield* registry.explainRefusal!(token)).toMatchObject({
      reason: "revoked",
      threadId,
      providerSessionId: first.config.providerSessionId,
    });
  }),
);

it.effect("renews an idle credential while its session is attached and expires it after", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    let attached = true;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-attached-idle");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("pi"),
      isAttached: Effect.sync(() => attached),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_000;
    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);
    // An unrelated issue prunes idle records; an attached one stays renewable.
    timestamp += 1_000;
    yield* registry.issue({
      threadId: ThreadId.make("thread-unrelated"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect((yield* registry.resolve(token))?.thread.threadId).toBe(threadId);

    attached = false;
    timestamp += 1_000;
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect((yield* registry.explainRefusal!(token)).reason).toBe("expired");
    attached = true;
    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect((yield* registry.explainRefusal!(token)).reason).toBe("revoked");
  }),
);

it.effect("inspect judges a credential as resolve would, without renewing it", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    let attached = true;
    const registry = yield* makeRegistry(() => timestamp);
    const tokenOf = (issued: { readonly config: { readonly authorizationHeader: string } }) =>
      issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const plainThread = ThreadId.make("thread-inspect-plain");
    const plain = tokenOf(
      yield* registry.issue({
        threadId: plainThread,
        providerInstanceId: ProviderInstanceId.make("codex"),
      }),
    );
    const attachedThread = ThreadId.make("thread-inspect-attached");
    const held = tokenOf(
      yield* registry.issue({
        threadId: attachedThread,
        providerInstanceId: ProviderInstanceId.make("pi"),
        isAttached: Effect.sync(() => attached),
      }),
    );
    timestamp += 50;
    expect(yield* registry.inspect(plain)).toEqual({ threadId: plainThread, recheckAt: 1_101 });
    // Inspecting is not use: the plain credential still expires a window after its issue.
    timestamp += 60;
    expect(yield* registry.inspect(plain)).toBeUndefined();
    expect(yield* registry.resolve(plain)).toBeUndefined();
    // An idle credential whose session is attached stays valid, rechecked a window later.
    expect(yield* registry.inspect(held)).toEqual({
      threadId: attachedThread,
      recheckAt: 1_210,
    });
    attached = false;
    expect(yield* registry.inspect(held)).toBeUndefined();
    expect(yield* registry.resolve(held)).toBeUndefined();
  }),
);

it.effect(
  "gives concurrently started threads different TMPDIRs that end with the server (#1206)",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const issueBoth = Effect.gen(function* () {
        const registry = yield* McpSessionRegistry.McpSessionRegistry;
        const issue = (name: string) =>
          registry.issue({
            threadId: ThreadId.make(`thread-tmp-${name}`),
            providerInstanceId: ProviderInstanceId.make("codex"),
          });
        const [first, second] = yield* Effect.all([issue("first"), issue("second")], {
          concurrency: "unbounded",
        });
        const again = yield* issue("first");
        const directories = [first.config.temporaryDirectory, second.config.temporaryDirectory];
        expect(new Set(directories).size).toBe(2);
        expect(again.config.temporaryDirectory).toBe(first.config.temporaryDirectory);
        // The system directory a thread shell's `goat app` still looks in holds the thread ones.
        const system = first.config.systemTemporaryDirectory ?? "\0";
        expect(first.config.temporaryDirectory?.startsWith(system)).toBe(true);
        for (const directory of directories) {
          expect((yield* fileSystem.stat(directory!)).type).toBe("Directory");
        }
        return directories;
      }).pipe(
        Effect.provide(
          McpSessionRegistry.layer.pipe(
            Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
            Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
          ),
        ),
      );

      const directories = yield* issueBoth;
      for (const directory of directories) expect(yield* fileSystem.exists(directory!)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("tells a token from an earlier server run apart from an unknown one", () =>
  Effect.gen(function* () {
    const current = yield* makeRegistry(() => 1_000);
    const earlier = yield* makeRegistry(() => 1_000);
    const issued = yield* earlier.issue({
      threadId: ThreadId.make("thread-before-restart"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(current.isRegistryToken!(token)).toBe(true);
    expect(yield* current.resolve(token)).toBeUndefined();
    expect((yield* current.explainRefusal!(token)).reason).toBe("earlier_server");
    // Builds before the run tag minted a bare 43-character secret.
    expect((yield* current.explainRefusal!(token.slice(8))).reason).toBe("earlier_server");
    expect((yield* current.explainRefusal!("payload.signature")).reason).toBe("unknown");
    expect((yield* current.explainRefusal!("")).reason).toBe("missing");
  }),
);

it.effect("keeps an idle attached credential through more than a tombstone list of churn", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const held = yield* registry.issue({
      threadId: ThreadId.make("thread-held-by-pi"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      isAttached: Effect.succeed(true),
    });
    const token = held.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_000;
    for (let index = 0; index < 600; index += 1) {
      const churn = yield* registry.issue({
        threadId: ThreadId.make("thread-churn-" + index),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      yield* registry.revokeProviderSession(churn.config.providerSessionId);
    }
    expect((yield* registry.resolve(token))?.thread.threadId).toBe(
      ThreadId.make("thread-held-by-pi"),
    );
  }),
);

it.effect("concurrent calls through an attachment probe all renew, and a revocation wins", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const probing = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const threadId = ThreadId.make("thread-concurrent-renewal");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("muse"),
      isAttached: Deferred.succeed(probing, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.as(true),
      ),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_000;
    const calls = yield* Effect.forEach([1, 2, 3], () => registry.resolve(token), {
      concurrency: "unbounded",
    }).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(probing);
    yield* Deferred.succeed(answer, undefined);
    const resolved = yield* Fiber.join(calls);
    expect(resolved.map((scope) => scope?.thread.threadId)).toEqual([threadId, threadId, threadId]);

    const revokeProbe = yield* Deferred.make<void>();
    const revokeAnswer = yield* Deferred.make<void>();
    const revoked = yield* registry.issue({
      threadId: ThreadId.make("thread-revoked-during-probe"),
      providerInstanceId: ProviderInstanceId.make("muse"),
      isAttached: Deferred.succeed(revokeProbe, undefined).pipe(
        Effect.andThen(Deferred.await(revokeAnswer)),
        Effect.as(false),
      ),
    });
    const revokedToken = revoked.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_000;
    const call = yield* registry
      .resolve(revokedToken)
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(revokeProbe);
    yield* registry.revokeProviderSession(revoked.config.providerSessionId);
    yield* Deferred.succeed(revokeAnswer, undefined);
    expect(yield* Fiber.join(call)).toBeUndefined();
    expect((yield* registry.explainRefusal!(revokedToken)).reason).toBe("revoked");
  }),
);

it.effect("a permit whose live-caller probe spans an authority change is refused", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const probing = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    let gate = false;
    const policy = { grant: "read_write" as const, policyEpoch: 1 };
    const request = {
      threadId: ThreadId.make("thread-permit-during-change"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      grantedScopes: ["memory:read", "memory:write"] as const,
      memoryPolicy: policy,
      readCurrentPolicy: () => Effect.succeed(policy),
      isLiveCaller: Effect.suspend(() =>
        gate
          ? Deferred.succeed(probing, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.as(true),
            )
          : Effect.succeed(true),
      ),
    };
    const first = yield* registry.issue(request);
    const scope = yield* registry.resolve(
      first.config.authorizationHeader.replace(/^Bearer\s+/, ""),
    );
    gate = true;
    const permit = yield* scope!.reauthorize!(["memory:write"]).pipe(
      Effect.flip,
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(probing);
    gate = false;
    yield* registry.issue({
      ...request,
      readOnly: true,
      renew: {
        authorizationHeader: first.config.authorizationHeader,
        providerSessionId: first.config.providerSessionId,
      },
    });
    yield* Deferred.succeed(answer, undefined);
    expect((yield* Fiber.join(permit))._tag).toBe("EnvironmentAuthorizationError");
  }),
);

it.effect("a revocation during a positive attachment probe still refuses the call", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const probing = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-revoked-while-attached"),
      providerInstanceId: ProviderInstanceId.make("pi"),
      isAttached: Deferred.succeed(probing, undefined).pipe(
        Effect.andThen(Deferred.await(answer)),
        Effect.as(true),
      ),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_000;
    const call = yield* registry.resolve(token).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(probing);
    yield* registry.revokeProviderSession(issued.config.providerSessionId);
    yield* Deferred.succeed(answer, undefined);
    expect(yield* Fiber.join(call)).toBeUndefined();
    expect((yield* registry.explainRefusal!(token)).reason).toBe("revoked");
  }),
);

it.effect(
  "refuses the header a held Codex thread keeps until its deferred reload, from the moment authority changes (#1569)",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const threadId = ThreadId.make("thread-deferred-reload");
      const policy = { grant: "read" as const, policyEpoch: 1 };
      const request = {
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["memory"] as const),
        grantedScopes: ["memory:read"] as const,
        memoryPolicy: policy,
        readCurrentPolicy: () => Effect.succeed(policy),
        isLiveCaller: Effect.succeed(true),
      };
      const list = (scope: McpInvocationContext.McpInvocationScope) =>
        MemoryFixture.call(
          "memory_list",
          { memorySpaceId: MemoryFixture.space, includeQuarantined: false },
          scope,
        );
      const first = yield* registry.issue(request);
      const header = first.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const held = yield* registry.resolve(header);
      expect((yield* list(held!)).result.isError).toBe(false);

      // Memory withdrawn: GOAT renews under the same token, and the old header that Codex keeps
      // sending, with memory tools still offered, can no longer run memory operations.
      yield* registry.issue({
        ...request,
        grantedScopes: [],
        readCurrentPolicy: () => Effect.succeed(undefined),
        renew: {
          authorizationHeader: first.config.authorizationHeader,
          providerSessionId: first.config.providerSessionId,
        },
      });
      for (const scope of [held!, (yield* registry.resolve(header))!])
        expect((yield* list(scope)).body).toMatchObject({ code: "unavailable" });

      // A new credential revokes the thread's old one first, so the old header stops resolving.
      yield* registry.revokeThread(threadId);
      const rotated = yield* registry.issue(request);
      expect(yield* registry.resolve(header)).toBeUndefined();
      expect((yield* registry.explainRefusal!(header)).reason).toBe("revoked");
      expect(
        yield* registry.resolve(rotated.config.authorizationHeader.replace(/^Bearer\s+/, "")),
      ).toBeDefined();
    }).pipe(Effect.provide(MemoryFixture.layer)),
);
