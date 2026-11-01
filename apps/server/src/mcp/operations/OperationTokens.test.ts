import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";
import { makeOperationTokens } from "./OperationTokens.ts";

const key = (fill: number) =>
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(fill)),
  });
const base = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "test",
  capabilities: new Set(["orchestration"] as const),
  issuedAt: 0,
  grantedScopes: [],
  reauthorize: () => Effect.void,
};
const thread = (threadId: string): McpInvocationScope => ({
  ...base,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});
const client = (sessionId: string): McpInvocationScope => ({
  ...base,
  thread: undefined,
  client: { sessionId, label: "outside", access: "full-access" },
});

it.effect("a handle reads back only for the principal and environment it was issued to", () =>
  Effect.gen(function* () {
    const tokens = yield* makeOperationTokens.pipe(Effect.provide(key(1)));
    const owner = thread("thread:owner");
    const token = yield* tokens.issue("task", "task:1", owner);
    expect(yield* tokens.verify(token, owner)).toMatchObject({ kind: "task", nativeId: "task:1" });
    // Session ids never travel inside the handle.
    const fromClient = yield* tokens.issue("task", "task:1", client("session-secret"));
    expect(Buffer.from(fromClient.split(".")[1]!, "base64url").toString()).not.toContain(
      "session-secret",
    );

    const refused = (candidate: string, scope: McpInvocationScope) =>
      Effect.flip(tokens.verify(candidate, scope));
    expect(yield* refused(token, thread("thread:other"))).toMatchObject({ reason: "not_found" });
    expect(
      yield* refused(token, { ...owner, environmentId: EnvironmentId.make("elsewhere") }),
    ).toMatchObject({ reason: "not_found" });
    // A replaced client session holds a different credential, so its old handles stay behind.
    expect(yield* refused(fromClient, client("session-renewed"))).toMatchObject({
      reason: "not_found",
    });
    const [prefix, body, signature] = token.split(".");
    const forged = Buffer.from(
      Buffer.from(body!, "base64url").toString().replace("task:1", "task:2"),
    ).toString("base64url");
    expect(yield* refused(`${prefix}.${forged}.${signature}`, owner)).toMatchObject({
      reason: "not_found",
    });
    expect(yield* refused("not-a-handle", owner)).toMatchObject({ reason: "not_found" });
  }),
);

it.effect("a handle signed by another environment's key is not found here", () =>
  Effect.gen(function* () {
    const scope = thread("thread:owner");
    const elsewhere = yield* makeOperationTokens.pipe(Effect.provide(key(2)));
    const token = yield* elsewhere.issue("task", "task:1", scope);
    const here = yield* makeOperationTokens.pipe(Effect.provide(key(1)));
    expect(yield* Effect.flip(here.verify(token, scope))).toMatchObject({ reason: "not_found" });
  }),
);
