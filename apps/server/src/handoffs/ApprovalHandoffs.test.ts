import { EnvironmentId } from "@goat/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import { openApprovalHandoffs } from "../goatclaw/openApprovalHandoffs.ts";
import { readBotAttention } from "../channels/channelBotAttention.ts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type * as ApprovalHandoffs from "./ApprovalHandoffs.ts";
import { instanceId, person, threadId, withApprovals } from "./ApprovalHandoffs.testkit.ts";

const targetPath = "hub.device_join";
const binding = { binding: "goat-hub-binding: join lidge-ts SHA256:key" };

const ask = (approvals: ApprovalHandoffs.ApprovalHandoffs["Service"]) =>
  Effect.gen(function* () {
    return yield* approvals.request({
      threadId,
      providerInstanceId: instanceId,
      targetPath,
      title: "Join lidge-ts to the hub",
      reason: "GOAT has no pinned host key for this alias.",
      location: "Approving links lidge-ts as a Remote Link Child.",
      binding,
      expiresAt: DateTime.add(yield* DateTime.now, { hours: 1 }),
    });
  });

it.effect("a person's approval covers exactly the change it was asked for, until it expires", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      const check = (input: { readonly targetPath?: string; readonly binding?: object }) =>
        approvals
          .verify({
            threadId,
            handoffId: summary.handoffId,
            targetPath: input.targetPath ?? targetPath,
            binding: { ...(input.binding ?? binding) },
          })
          .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "approved" }));
      expect(yield* check({})).toContain("still open");
      expect((yield* openApprovalHandoffs()).handoffs[0]?.botAttentionOwned).toBeUndefined();
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      expect(yield* check({})).toBe("approved");
      expect(
        yield* check({ binding: { binding: "goat-hub-binding: join lidge-ts SHA256:other" } }),
      ).toContain("does not cover");
      expect(yield* check({ targetPath: "hub.device_leave" })).toContain("does not cover");
      yield* TestClock.adjust("2 hours");
      expect(yield* check({})).toContain("expired");
    }),
  ),
);

it.effect("a declined approval approves nothing", () =>
  withApprovals(({ approvals, handoffs }) =>
    Effect.gen(function* () {
      const summary = yield* ask(approvals);
      yield* handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      const result = yield* approvals
        .verify({ threadId, handoffId: summary.handoffId, targetPath, binding })
        .pipe(Effect.flip);
      expect(result.message).toContain("was not given");
    }),
  ),
);

it.effect.each(["needs_you", "off"] as const)(
  "a worker handoff is the only attention event in %s mode",
  (mode) =>
    withApprovals(({ approvals }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const now = DateTime.formatIso(yield* DateTime.now);
        const environmentId = EnvironmentId.make("origin");
        yield* sql`INSERT INTO channel_conversations
          (conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at)
          VALUES ('conversation', 'owner', 'goat', 'connection', 'key', ${now})`;
        yield* sql`INSERT INTO channel_tasks
          (task_id, owner_id, conversation_id, status, version, generation, worker_thread_id,
           task_json, created_at, updated_at)
          VALUES ('task', 'owner', 'conversation', 'running', 2, 1, ${threadId},
           ${JSON.stringify({ worker: { threadId, environmentId } })}, ${now}, ${now})`;
        const handoff = yield* ask(approvals);
        const read = (ownerId: string) =>
          readBotAttention(sql, {
            ownerId,
            environmentId,
            mode,
            request: { cursor: 0 },
            resolveName: () => Effect.succeed("Scout"),
          });
        const page = yield* read("owner");
        expect(page.mode).toBe(mode);
        expect((yield* openApprovalHandoffs()).handoffs).toMatchObject([
          { handoff: { handoffId: handoff.handoffId }, botAttentionOwned: true },
        ]);
        expect(page.events).toMatchObject([
          {
            kind: "approval",
            taskId: "task",
            requestId: handoff.handoffId,
            request: { kind: "handoff", threadId, requestId: handoff.handoffId },
          },
        ]);
        expect((yield* read("another-owner")).events).toEqual([]);
      }),
    ),
);
