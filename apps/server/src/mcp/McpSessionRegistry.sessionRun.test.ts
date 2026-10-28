import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const makeRegistry = McpSessionRegistry.__testing.make({}).pipe(
  Effect.provideService(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  Effect.provideService(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("session-run-test")),
    getDescriptor: Effect.die("unused"),
  }),
  Effect.provide(NodeServices.layer),
);
const tokenOf = (issued: McpSessionRegistry.McpIssuedCredential) =>
  issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

it.effect(
  "rejects run A's bearer after run B replaces the session credential and resolves B's run",
  () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry;
      const threadId = ThreadId.make("goat-bot-session:credential:1");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const a = yield* registry.issue({ threadId, providerInstanceId, runId: RunId.make("run-a") });
      yield* registry.revokeThread(threadId);
      const b = yield* registry.issue({ threadId, providerInstanceId, runId: RunId.make("run-b") });
      expect(yield* registry.resolve(tokenOf(a))).toBeUndefined();
      expect((yield* registry.resolve(tokenOf(b)))?.thread.runId).toBe("run-b");
    }),
);

it.effect("preserves the ordinary thread's credential when renewing authority between runs", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry;
    const threadId = ThreadId.make("ordinary-thread");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const a = yield* registry.issue({ threadId, providerInstanceId });
    const b = yield* registry.issue({ threadId, providerInstanceId, renew: a.config });
    expect(b.config.providerSessionId).toBe(a.config.providerSessionId);
    expect(b.config.authorizationHeader).toBe(a.config.authorizationHeader);
    expect((yield* registry.resolve(tokenOf(a)))?.thread.runId).toBeUndefined();
  }),
);
