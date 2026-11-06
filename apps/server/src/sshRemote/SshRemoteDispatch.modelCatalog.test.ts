import { ProviderInstanceId } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";
import { host, withRemote } from "./SshRemoteDispatch.hostCall.testkit.ts";
import { withLinkedHost } from "./testkit/LinkedHostFixture.ts";

const catalogPointer = (alias: string) =>
  `goat_call {path:"provider.list", args:{host:"${alias}"}}`;

const structured = (value: unknown) => ({ result: { structuredContent: value } });

describe("a model another machine lacks", () => {
  it.effect("keeps the destination's refusal and points at that host's catalog", () =>
    Effect.gen(function* () {
      const refusal =
        'Provider codex here does not offer model gpt-x, even after refreshing its model list. Pick one goat_call {path:"provider.list"} lists for it.';
      const { result } = yield* withLinkedHost(
        (request) => {
          if (request.method === "tools/list") return { result: { tools: [] } };
          if (request.tool === "goat_project_list")
            return structured({
              projects: [{ id: "project-1", workspaceRoot: "/srv/app" }],
              nextCursor: null,
            });
          return {
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ code: "invalid_request", message: refusal }),
                },
              ],
            },
          };
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.launchThread(
            {
              host: "box",
              cwd: "/srv/app",
              workspace: { type: "cwd" },
              title: "Fix it",
              message: "Go",
              runtimeMode: "approval-required",
              callerRuntimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-x" },
            },
            Effect.void,
          );
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "remote_refused", remoteCode: "invalid_request" },
      });
      const failure = result._tag === "Failure" ? result.failure : undefined;
      expect(failure?.message).toContain(refusal);
      expect(failure?.message).toContain(catalogPointer("box"));
      expect(failure?.launchMayHaveStarted).toBeUndefined();
    }),
  );

  it.effect("preflight searches the host's catalog for the model and names that host", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        {
          answer: ({ method, tool }) =>
            method !== "tools/call"
              ? { result: { tools: [] } }
              : tool === "goat_environment_read"
                ? structured({ environmentId: "remote" })
                : tool === "orchestrator_capabilities"
                  ? structured({
                      parentThreadId: null,
                      inheritedProviderInstanceId: null,
                      inheritedModel: null,
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      providers: [
                        {
                          providerInstanceId: "codex",
                          driverKind: "codex",
                          displayName: null,
                          models: [{ id: "gpt-other" }],
                          canRunChildTask: true,
                          canRunCrossProviderChildTask: true,
                          constraints: [],
                        },
                      ],
                      features: {
                        appOwnedSubagents: true,
                        asyncPolling: true,
                        cancellation: true,
                        batchThreadCreation: true,
                        threadManagement: true,
                        incrementalThreadRead: true,
                        scheduledTasks: true,
                        maxBatchThreads: 10,
                      },
                    })
                  : structured({}),
        },
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.preflightTarget({
            target: { alias: host, hostname: host, username: null, port: null },
            runtimeMode: "full-access",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-x" },
          });
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: "remote_refused", remoteCode: "model_unavailable" },
      });
      expect(result._tag === "Failure" ? result.failure.message : "").toContain(
        catalogPointer(host),
      );
      expect(
        record.toolCallArguments.filter((call) => call.tool === "orchestrator_capabilities"),
      ).toEqual([
        { tool: "orchestrator_capabilities", arguments: { search: "gpt-x" } },
        { tool: "orchestrator_capabilities", arguments: { search: "gpt-x" } },
      ]);
    }),
  );
});
