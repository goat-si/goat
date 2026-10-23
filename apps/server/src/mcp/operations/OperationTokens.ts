// @effect-diagnostics-next-line nodeBuiltinImport:off -- HMAC-SHA256 and a constant-time compare over a per-environment key.
import * as NodeCrypto from "node:crypto";

import { OperationError, OperationKind } from "@goat/contracts/agentSurface/operation";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import type { McpInvocationScope } from "../McpInvocationContext.ts";

const KEY_NAME = "agent-surface-operation-key";
const PREFIX = "op1";

const Payload = Schema.Struct({
  k: OperationKind,
  n: Schema.String,
  e: Schema.String,
  p: Schema.String,
  t: Schema.Number,
});
const PayloadJson = Schema.fromJsonString(Payload);
const decodePayload = Schema.decodeUnknownOption(PayloadJson);
const encodePayload = Schema.encodeSync(PayloadJson);

/** Whoever received the handle: a thread, an outside client session, or this process. */
const principalOf = (scope: McpInvocationScope | undefined) =>
  scope?.thread !== undefined
    ? `thread:${scope.thread.threadId}`
    : scope?.client !== undefined
      ? `client:${scope.client.sessionId}`
      : "process";
// Digested so a client's session id never reaches an agent inside a handle.
const digest = (principal: string) =>
  NodeCrypto.createHash("sha256").update(principal).digest("base64url").slice(0, 22);

export interface VerifiedOperation {
  readonly kind: OperationKind;
  readonly nativeId: string;
  readonly issuedAtMs: number;
}

const notFound = () =>
  new OperationError({
    reason: "not_found",
    message:
      "No operation with that id was issued here to this caller. Start or find the work again.",
  });

/**
 * Signs operation handles with this environment's own key: kind, native id, environment, the
 * receiving principal and issue time. A signature separates "issued but lost" (the work reads
 * unknown) from "never issued here" (not_found).
 */
export const makeOperationTokens = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  let cached: Uint8Array | undefined;
  // Loaded on first use, so registering the tools never touches the secret store.
  const key = Effect.suspend(() =>
    cached !== undefined
      ? Effect.succeed(cached)
      : store.getOrCreateRandom(KEY_NAME, 32).pipe(
          Effect.tap((value) => Effect.sync(() => void (cached = value))),
          Effect.orDie,
        ),
  );
  const sign = (secret: Uint8Array, body: string) =>
    NodeCrypto.createHmac("sha256", secret).update(body).digest();

  const issue = Effect.fn("OperationTokens.issue")(function* (
    kind: OperationKind,
    nativeId: string,
    scope: McpInvocationScope | undefined,
  ) {
    const secret = yield* key;
    const body = Buffer.from(
      encodePayload({
        k: kind,
        n: nativeId,
        e: scope?.environmentId ?? "",
        p: digest(principalOf(scope)),
        t: yield* Clock.currentTimeMillis,
      }),
    ).toString("base64url");
    return `${PREFIX}.${body}.${sign(secret, body).toString("base64url")}`;
  });

  const verify = Effect.fn("OperationTokens.verify")(function* (
    token: string,
    scope: McpInvocationScope | undefined,
  ) {
    const secret = yield* key;
    const [prefix, body, signature, ...rest] = token.split(".");
    if (prefix !== PREFIX || body === undefined || signature === undefined || rest.length > 0)
      return yield* notFound();
    const expected = sign(secret, body);
    const given = Buffer.from(signature, "base64url");
    if (given.length !== expected.length || !NodeCrypto.timingSafeEqual(given, expected))
      return yield* notFound();
    const payload = decodePayload(Buffer.from(body, "base64url").toString("utf8"));
    if (
      payload._tag === "None" ||
      payload.value.e !== (scope?.environmentId ?? "") ||
      payload.value.p !== digest(principalOf(scope))
    )
      return yield* notFound();
    return {
      kind: payload.value.k,
      nativeId: payload.value.n,
      issuedAtMs: payload.value.t,
    } satisfies VerifiedOperation;
  });

  return { issue, verify };
});

export type OperationTokens = Effect.Success<typeof makeOperationTokens>;
