import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { readThread } from "./threadAccess.ts";

const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
const client: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:thread-access"),
  requestNamespace: "client:thread-access",
  thread: undefined,
  client: { sessionId: "thread-access", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const readBare = (existing: ReadonlyArray<ThreadId>, threadId = bareId) =>
  readThread(threadId).pipe(
    Effect.flip,
    Effect.provideService(McpInvocationContext.McpInvocationContext, client),
    Effect.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(existing.includes(threadId) ? liveThreadShell(threadId) : null),
      }),
    ),
  );

it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
  Effect.gen(function* () {
    const error = yield* readBare([ThreadId.make(`mcp:${bareId}`)]);

    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe(`The thread was not found. Did you mean \`mcp:${bareId}\`?`);
  }),
);

it.effect("points a live caller allowed to reach linked hosts to the host argument", () =>
  Effect.gen(function* () {
    const caller = liveThreadShell(ThreadId.make("thread:caller"));
    const scope = {
      ...client,
      client: undefined,
      thread: {
        threadId: caller.id,
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    };
    for (const allowed of [true, false]) {
      const error = yield* readThread(bareId).pipe(
        Effect.flip,
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: (id) => Effect.succeed(id === caller.id ? caller : null),
            }),
            Layer.mock(Profiles.PermissionProfiles)({
              check: () =>
                Effect.succeed(
                  allowed
                    ? {
                        ok: true,
                        effective: {
                          enabled: false,
                          profile: BUILTIN_PERMISSION_PROFILES.owner,
                          runtimeMode: "full-access",
                        },
                      }
                    : { ok: false, reason: "Remote work is denied." },
                ),
            }),
          ),
        ),
      );
      expect(error.code).toBe("thread_not_found");
      if (allowed) {
        expect(error.message).toContain("goat_host_link_list");
        expect(error.message).toContain("`host`");
      } else {
        expect(error.message).toBe("The thread was not found.");
      }
    }
  }),
);

it.effect("does not look up a corrected id when the session has lost read authority", () =>
  Effect.gen(function* () {
    const error = yield* readThread(bareId).pipe(
      Effect.flip,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...client,
        reauthorize: () =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: "The MCP session is no longer active.",
              requiredScope: "orchestration:read",
            }),
          ),
      }),
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) =>
            id === bareId ? Effect.succeed(null) : Effect.die("Unauthorized corrected-id lookup"),
        }),
      ),
    );
    expect(error.code).toBe("thread_not_found");
    expect(error.message).toBe("The thread was not found.");
  }),
);

it.effect("suggests the encoded delegated-task thread and keeps malformed IDs as misses", () =>
  Effect.gen(function* () {
    const commandId = `command:mcp:${bareId}:delegate-task:review`;
    const encoded = ThreadId.make(`thread:delegated-task:${encodeURIComponent(commandId)}`);
    const error = yield* readBare([encoded], ThreadId.make(`thread:delegated-task:${commandId}`));
    expect(error.code).toBe("thread_not_found");
    expect(error.message).toContain(`\`${encoded}\``);
    const malformed = yield* readBare([], ThreadId.make("thread:delegated-task:\ud800"));
    expect(malformed.message).toBe("The thread was not found.");
  }),
);
