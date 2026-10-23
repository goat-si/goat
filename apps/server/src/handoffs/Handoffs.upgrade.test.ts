// @effect-diagnostics nodeBuiltinImport:off -- rewrites a stored payload in Handoffs' own AES-GCM format.
import * as NodeCrypto from "node:crypto";

import { assert, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { durableHandoffs, instanceId, threadId, withHarness } from "./Handoffs.testkit.ts";

it.effect(
  "finds a host sync approval asked before it became a continuation path once approved",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const reviewer = AuthSessionId.make("host-sync-reviewer");
        const environmentId = EnvironmentId.make("host-sync-environment");
        const now = yield* DateTime.now;
        const durable = yield* durableHandoffs(orchestrator, {
          environmentId,
          sessions: Effect.succeed([
            {
              sessionId: reviewer,
              subject: "test",
              method: "browser-session-cookie",
              scopes: ["orchestration:operate", "providers:manage"],
              client: { label: "Human reviewer", deviceType: "unknown" },
              issuedAt: now,
              expiresAt: DateTime.add(now, { days: 1 }),
              lastConnectedAt: now,
              connected: true,
              current: true,
            },
          ]),
        });
        const service = yield* durable.start;
        const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
        const summary = yield* service.create({
          kind: "approval",
          title: "Install OpenCode?",
          reason: "An agent asked",
          requestedBy: { threadId, providerInstanceId: instanceId, path: "provider.host_sync" },
          target: { environmentId, path: "provider.host_sync" },
          runId: run.id,
          nodeId: run.rootNodeId!,
          human: { location: "Each machine runs its own installer." },
          args: { driver: "opencode", hosts: [], version: null, login: true },
        });
        // Rewrite the stored payload the way builds before this path was listed wrote it.
        const key = Buffer.from(
          Option.getOrThrow(yield* durable.store.get("handoff-encryption-key")),
        );
        const name = `handoff-${NodeCrypto.createHash("sha256").update(summary.handoffId).digest("hex")}`;
        const stored = Buffer.from(Option.getOrThrow(yield* durable.store.get(name)));
        const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, stored.subarray(0, 12));
        decipher.setAuthTag(stored.subarray(12, 28));
        const { namespace, ...legacy } = JSON.parse(
          Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString("utf8"),
        );
        assert.equal(namespace, "provider.host_sync");
        const iv = NodeCrypto.randomBytes(12);
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        const body = Buffer.concat([cipher.update(JSON.stringify(legacy), "utf8"), cipher.final()]);
        yield* durable.store.set(name, Buffer.concat([iv, cipher.getAuthTag(), body]));

        const restarted = yield* durable.start;
        yield* restarted.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          reviewer,
        );
        const [continuation] =
          yield* restarted.completedProviderContinuations("provider.host_sync");
        assert.equal(continuation?.handoff.handoffId, summary.handoffId);
        assert.equal(continuation?.approvedBySessionId, reviewer);
      }),
    ),
);
