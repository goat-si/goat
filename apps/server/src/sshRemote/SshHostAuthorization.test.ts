import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { McpCapability, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { authorizeApprovalRequest } from "./SshHostAuthorization.ts";

const thread = {
  threadId: ThreadId.make("agent-thread"),
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
};

const liveThread = (
  reauthorize: (
    required: ReadonlyArray<AuthEnvironmentScope>,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>,
  overrides: Partial<McpInvocationScope> = {},
): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env"),
  requestNamespace: "test",
  capabilities: new Set<McpCapability>(["orchestration"]),
  issuedAt: 0,
  readOnly: false,
  thread,
  client: undefined,
  grantedScopes: ["orchestration:read"],
  reauthorize,
  ...overrides,
});

it.effect(
  "allows a live writable thread with orchestration:read and reauthorizes exactly that scope",
  () =>
    Effect.gen(function* () {
      const seen: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
      yield* authorizeApprovalRequest(
        liveThread((required) => Effect.sync(() => void seen.push(required))),
      );
      expect(seen).toEqual([["orchestration:read"]]);
    }),
);

it.effect.each([
  "read-only",
  "outside-client",
  "no-thread",
  "no-reauthorize",
  "missing-read",
  "no-capability",
] as const)("denies an approval request when the caller is %s", (reason) =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
    const reauthorize = (required: ReadonlyArray<AuthEnvironmentScope>) =>
      Effect.sync(() => void seen.push(required));
    const recorded = liveThread(reauthorize, {
      ...(reason === "read-only" ? { readOnly: true } : {}),
      ...(reason === "outside-client"
        ? {
            client: {
              sessionId: "outside",
              label: "CLI",
              access: "full-access" as const,
            },
            grantedScopes: ["orchestration:read", "orchestration:operate"] as const,
          }
        : {}),
      ...(reason === "no-thread" ? { thread: undefined } : {}),
      ...(reason === "missing-read" ? { grantedScopes: ["orchestration:operate"] as const } : {}),
      ...(reason === "no-capability" ? { capabilities: new Set<McpCapability>() } : {}),
    });
    const scope =
      reason === "no-reauthorize"
        ? (({ reauthorize: _reauthorize, ...rest }) => rest)(recorded)
        : recorded;
    const error = yield* authorizeApprovalRequest(scope).pipe(Effect.flip);
    expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
    expect(error).toMatchObject({ requiredScope: "orchestration:read" });
    expect(seen).toEqual([]);
  }),
);

it.effect("denies when reauthorize fails because the turn is no longer live", () =>
  Effect.gen(function* () {
    const seen: Array<ReadonlyArray<AuthEnvironmentScope>> = [];
    const error = yield* authorizeApprovalRequest(
      liveThread((required) =>
        Effect.sync(() => void seen.push(required)).pipe(
          Effect.andThen(
            Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "orchestration:read",
                message: "The turn is no longer live.",
              }),
            ),
          ),
        ),
      ),
    ).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredScope: "orchestration:read",
      message: "The turn is no longer live.",
    });
    expect(seen).toEqual([["orchestration:read"]]);
  }),
);
