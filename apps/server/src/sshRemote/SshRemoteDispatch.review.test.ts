import { EnvironmentId } from "@goat/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";

import { host, initialize, withRemote } from "./SshRemoteDispatch.hostCall.testkit.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const otherId = EnvironmentId.make("managed-owner");
const withOther = <A, E>(
  other: NonNullable<SshTunnel.SshEnvironmentManagerShape["existingEnvironmentOther"]>,
  answer: Parameters<typeof withRemote>[0]["answer"],
  body: Effect.Effect<A, E, SshRemoteDispatch.SshRemoteDispatch>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = SshTunnel.SshEnvironmentManager.of;
      return vi.spyOn(SshTunnel.SshEnvironmentManager, "of").mockImplementation((manager) =>
        original({
          ...manager,
          existingEnvironmentOther: other,
          existingEnvironment: () =>
            Effect.succeed({ httpBaseUrl: "http://127.0.0.1:42000/", remoteServerVersion: "test" }),
          issueExistingMcpSession: () =>
            Effect.succeed({
              token: "alternate",
              expiresAt: null,
              runtimeModeCeilingApplied: true,
            }),
        }),
      );
    }),
    () => withRemote({ answer }, body),
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

const missing = {
  result: { isError: true, structuredContent: { code: "thread_not_found", message: "missing" } },
};
const answer = (request: Parameters<Parameters<typeof withRemote>[0]["answer"]>[0]) => {
  const initial = initialize(request);
  if (initial !== undefined) return initial;
  if (request.method === "tools/list")
    return {
      result: {
        tools: [
          { name: "goat_thread_read" },
          { name: "goat_pending_request_list" },
          { name: "goat_pending_request_read" },
          { name: "goat_pending_request_respond" },
        ],
      },
    };
  if (request.tool === "goat_environment_read")
    return { result: { structuredContent: { environmentId: "app-owner" } } };
  if (request.authorization !== "Bearer alternate") return missing;
  if (request.tool === "goat_pending_request_list")
    return { result: { structuredContent: { requestIds: ["question-1"] } } };
  if (request.tool === "goat_pending_request_read")
    return { result: { structuredContent: { requestId: "question-1", questions: [] } } };
  return missing;
};

const call = (tool: string, writes = false, environmentId?: EnvironmentId) =>
  Effect.gen(function* () {
    const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
    return yield* dispatch.callHostTool(
      {
        host,
        tool,
        arguments: { threadId: "thread-1", requestId: "question-1" },
        writes,
        timeoutMs: 5_000,
        ...(environmentId === undefined ? {} : { environmentId }),
      },
      Effect.succeed("full-access"),
    );
  });

describe("SSH review regressions", () => {
  it.effect.each([
    ["recorded offline alternate", { kind: "unavailable" } as const, "host_unavailable"],
    ["no alternate", { kind: "absent" } as const, "remote_refused"],
  ] as const)("legacy read with %s returns %s", ([, other, reason]) =>
    Effect.gen(function* () {
      const { result, record } = yield* withOther(
        () => Effect.succeed(other),
        answer,
        call("goat_thread_read"),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
      if (result._tag === "Failure" && other.kind === "absent")
        expect(result.failure.remoteCode).toBe("thread_not_found");
      expect(record.toolCalls.filter((tool) => tool === "goat_thread_read")).toHaveLength(1);
    }),
  );

  it.effect("list then read finds a pending request in the alternate database", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const { result } = yield* withOther(
        () => Effect.succeed({ kind: "live", environmentId: otherId }),
        (request) => {
          if (request.tool?.startsWith("goat_pending_request_"))
            seen.push(`${request.tool}:${request.authorization}`);
          return answer(request);
        },
        Effect.gen(function* () {
          const listed = yield* call("goat_pending_request_list");
          const read = yield* call("goat_pending_request_read");
          return [listed, read];
        }),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: [{ requestIds: ["question-1"] }, { requestId: "question-1" }],
      });
      expect(seen).toContain("goat_pending_request_read:Bearer alternate");
    }),
  );

  it.effect("pending request read follows a saved origin and respond never retries", () =>
    Effect.gen(function* () {
      let alternateLookups = 0;
      const { result, record } = yield* withOther(
        () => {
          alternateLookups++;
          return Effect.succeed({ kind: "live", environmentId: otherId });
        },
        answer,
        Effect.all([
          call("goat_pending_request_read", false, otherId),
          call("goat_pending_request_respond", true).pipe(Effect.result),
        ]),
      );
      expect(result).toMatchObject({
        _tag: "Success",
        success: [
          { requestId: "question-1" },
          { _tag: "Failure", failure: { remoteCode: "thread_not_found" } },
        ],
      });
      expect(alternateLookups).toBe(0);
      expect(
        record.toolCalls.filter((tool) => tool === "goat_pending_request_respond"),
      ).toHaveLength(1);
    }),
  );
});
