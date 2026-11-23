import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ANTIGRAVITY_DEFAULT_MODEL } from "@goat/contracts";
import { symlinksSupported } from "@goat/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { AcpRequestError } from "effect-acp/errors";
import { expect } from "vite-plus/test";

import { removeAntigravitySessionFiles } from "../provider/acp/AntigravitySessionFiles.ts";

import { isAntigravityTextGenerationAvailable } from "./AntigravityTextGeneration.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";

import {
  requestContext,
  SESSION_ID,
  modelSelection,
  encodeMetadata,
  makeFixture,
} from "./AntigravityTextGeneration.testkit.ts";

const memorySelection = M.MemoryModelSelection.make({
  instanceId: M.ProviderInstanceId.make("antigravity-test"),
  model: "gemini-test",
  options: [],
});
const memoryContext = {
  providerInstanceId: memorySelection.instanceId,
  environmentId: M.EnvironmentId.make("memory-owner"),
};
const memoryId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const memoryRevision = M.MemoryRevision.make({
  memorySpaceId: M.MemorySpaceId.make(memoryId(1)),
  memoryId: M.MemoryId.make(memoryId(2)),
  revisionId: M.MemoryRevisionId.make(memoryId(3)),
  payloadRef: M.MemoryRevisionId.make(memoryId(3)),
  operationId: M.MemoryOperationId.make(memoryId(4)),
  parents: [],
  scope: { kind: "user" },
  assertionKind: "inference",
  provenance: { environmentId: memoryContext.environmentId },
  createdAtUtc: "2026-10-14T00:00:00.000Z",
});
const memoryPayload = M.MemoryPayload.make({
  text: "Synthetic input",
  evidence: [],
  derivedFromMemoryRevisions: [],
});
const memorySummary = M.GenerateMemorySummaryInput.make({
  cwd: process.cwd(),
  sourceThread: {
    environmentId: memoryContext.environmentId,
    threadId: M.ThreadId.make("synthetic-thread"),
  },
  sourceWatermark: {
    fromEventId: M.EventId.make("e1"),
    toEventId: M.EventId.make("e2"),
    throughSequence: 2,
  },
  messages: [{ messageId: M.MessageId.make("m1"), text: "Synthetic input", completed: true }],
  modelSelection: memorySelection,
});
const memoryConflict = M.ResolveMemoryConflictInput.make({
  cwd: memorySummary.cwd,
  memorySpaceId: memoryRevision.memorySpaceId,
  memoryId: memoryRevision.memoryId,
  conflictId: M.MemoryConflictId.make(memoryId(8)),
  heads: [
    { revision: memoryRevision, payload: memoryPayload },
    {
      revision: {
        ...memoryRevision,
        revisionId: M.MemoryRevisionId.make(memoryId(5)),
        payloadRef: M.MemoryRevisionId.make(memoryId(5)),
      },
      payload: memoryPayload,
    },
  ],
  modelSelection: memorySelection,
});
const memoryOutput = { text: "Synthetic result", assertionKind: "inference", evidence: [] };
const memoryOperations = ["resolveMemoryConflict", "generateMemorySummary"] as const;

it.layer(NodeServices.layer)("AntigravityTextGeneration", (it) => {
  it.effect.each(memoryOperations)(
    "fails an undisclosed Antigravity model before prompting for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          currentModel: "",
          modelOptions: [],
        });
        const selection = { ...memorySelection, model: ANTIGRAVITY_DEFAULT_MODEL };
        const error = yield* (
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!({
                ...memoryConflict,
                modelSelection: selection,
              }).pipe(Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome))
            : fixture.textGeneration.generateMemorySummary!({
                ...memorySummary,
                modelSelection: selection,
              })
        ).pipe(Effect.flip);
        expect(error.detail).toContain("did not disclose");
        expect(error.cause).toEqual(new MemoryGenerationRunnerError({ code: "unavailable" }));
        expect(fixture.state.prompts).toEqual([]);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect.each(memoryOperations)(
    "captures the selected Antigravity default alias for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          outputs: [
            JSON.stringify(
              operation === "resolveMemoryConflict"
                ? { ...memoryOutput, judgment: "Synthetic" }
                : { summary: memoryOutput },
            ),
          ],
        });
        const selection = { ...memorySelection, model: ANTIGRAVITY_DEFAULT_MODEL };
        const flags = yield* fixture.textGeneration.memoryCapabilities;
        expect(operation === "resolveMemoryConflict" ? flags.conflict : flags.summary).toBe(true);
        const generated =
          operation === "resolveMemoryConflict"
            ? yield* fixture.textGeneration.resolveMemoryConflict!({
                ...memoryConflict,
                modelSelection: selection,
              })
            : yield* fixture.textGeneration.generateMemorySummary!({
                ...memorySummary,
                modelSelection: selection,
              });
        expect(generated.execution.effectiveModel).toBe(modelSelection.model);
        expect(generated.execution.requestedModelSelection).toEqual(selection);
        expect(fixture.state.selectedModels).toEqual([]);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "fails unavailable Antigravity model before prompting for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ memoryRunnerContext: memoryContext });
        const selection = { ...memorySelection, model: "unavailable-synthetic-model" };
        const error = yield* (
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!({
                ...memoryConflict,
                modelSelection: selection,
              }).pipe(Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome))
            : fixture.textGeneration.generateMemorySummary!({
                ...memorySummary,
                modelSelection: selection,
              })
        ).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(fixture.state.prompts).toEqual([]);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "fails Antigravity auth admission before runtime creation for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          rejectAdmission: true,
        });
        const error = yield* (
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : fixture.textGeneration.generateMemorySummary!(memorySummary)
        ).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        expect(fixture.state.workspaces).toEqual([]);
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "rejects memory output over the schema byte budget for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          outputs: [
            JSON.stringify(
              operation === "resolveMemoryConflict"
                ? {
                    ...memoryOutput,
                    text: "x".repeat(65536),
                    judgment: "Synthetic",
                  }
                : {
                    summary: {
                      ...memoryOutput,
                      text: "x".repeat(65536),
                    },
                  },
            ),
          ],
        });
        const error = yield* (
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : fixture.textGeneration.generateMemorySummary!(memorySummary)
        ).pipe(Effect.flip);
        expect(error.operation).toBe(operation);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "runs %s in isolation with selected model provenance",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          outputs: [
            JSON.stringify(
              operation === "resolveMemoryConflict"
                ? { ...memoryOutput, judgment: "Synthetic judgment" }
                : { summary: memoryOutput },
            ),
          ],
        });
        const generated =
          operation === "resolveMemoryConflict"
            ? yield* fixture.textGeneration.resolveMemoryConflict!(memoryConflict)
            : yield* fixture.textGeneration.generateMemorySummary!(memorySummary);
        expect(generated.execution).toEqual({
          requestedModelSelection: memorySelection,
          effectiveModel: "gemini-test",
          effectiveProvider: "antigravity",
          providerInstanceId: memoryContext.providerInstanceId,
          environmentId: memoryContext.environmentId,
        });
        expect(fixture.state.workspaces).not.toContain(memorySummary.cwd);
        expect(fixture.state.selectedModes).toEqual(["default"]);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "rejects tool attempts despite apparent success for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: memoryContext,
          prompt: ({ emit }) =>
            Effect.gen(function* () {
              yield* emit({
                sessionUpdate: "tool_call",
                toolCallId: "synthetic-tool",
                title: "Tool attempt",
                status: "pending",
              });
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: JSON.stringify(
                    operation === "resolveMemoryConflict"
                      ? { ...memoryOutput, judgment: "Synthetic judgment" }
                      : { summary: memoryOutput },
                  ),
                },
              });
              return { stopReason: "end_turn" as const };
            }),
        });
        const exit = yield* Effect.exit(
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : fixture.textGeneration.generateMemorySummary!(memorySummary),
        );
        expect(exit._tag).toBe("Failure");
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)("rejects forged execution JSON for %s", (operation) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        memoryRunnerContext: memoryContext,
        outputs: [
          JSON.stringify(
            operation === "resolveMemoryConflict"
              ? {
                  ...memoryOutput,
                  judgment: "Synthetic",
                  execution: { effectiveModel: "forged" },
                }
              : {
                  summary: {
                    ...memoryOutput,
                    execution: { effectiveModel: "forged" },
                  },
                },
          ),
        ],
      });
      const exit = yield* Effect.exit(
        operation === "resolveMemoryConflict"
          ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
              Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
            )
          : fixture.textGeneration.generateMemorySummary!(memorySummary),
      );
      expect(exit._tag).toBe("Failure");
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "rejects configured global MCP before runtime creation for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ memoryRunnerContext: memoryContext });
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(fixture.profileDirectory, "config"), { recursive: true });
        yield* fs.writeFileString(
          path.join(fixture.profileDirectory, "config", "mcp_config.json"),
          '{"mcpServers":{"synthetic":{}}}',
        );
        const flags = yield* fixture.textGeneration.memoryCapabilities;
        expect(operation === "resolveMemoryConflict" ? flags.conflict : flags.summary).toBe(false);
        const exit = yield* Effect.exit(
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : fixture.textGeneration.generateMemorySummary!(memorySummary),
        );
        expect(exit._tag).toBe("Failure");
        expect(fixture.state.workspaces).toEqual([]);
      }).pipe(Effect.scoped),
  );
  it.effect.each(memoryOperations)(
    "rejects mismatched instance before runtime creation for %s",
    (operation) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          memoryRunnerContext: {
            ...memoryContext,
            providerInstanceId: M.ProviderInstanceId.make("other-instance"),
          },
        });
        const exit = yield* Effect.exit(
          operation === "resolveMemoryConflict"
            ? fixture.textGeneration.resolveMemoryConflict!(memoryConflict).pipe(
                Effect.map((outcome): M.GenerateMemorySummaryOutcome => outcome),
              )
            : fixture.textGeneration.generateMemorySummary!(memorySummary),
        );
        expect(exit._tag).toBe("Failure");
        expect(fixture.state.workspaces).toEqual([]);
      }).pipe(Effect.scoped),
  );
  it.effect.each([false, true])(
    "generates all helper types and cleans up with startupSkills=%s",
    (startupSkills) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          startupSkills,
          outputs: [
            '{"subject":"  Repair Google login.\\nExtra line","body":"  Keep the remote callback.  ","branch":"Repair Login"}',
            '```json\n{"title":" Repair Google login\\nExtra line","body":"  ## Summary\\nSupport remote callbacks.  "}\n```',
            '{"branch":" Repair Google Login "}',
            '{"title":"  \\"Repair Google login\\"  "}',
          ],
        });
        const common = { cwd: fixture.projectDirectory, modelSelection };
        expect(
          yield* fixture.textGeneration.generateCommitMessage({
            ...common,
            branch: "feature/login",
            stagedSummary: "M login.ts",
            stagedPatch: "+handleRemoteCallback()",
            includeBranch: true,
          }),
        ).toEqual({
          subject: "Repair Google login",
          body: "Keep the remote callback.",
          branch: "feature/repair-login",
        });
        expect(
          yield* fixture.textGeneration.generatePrContent({
            ...common,
            baseBranch: "main",
            headBranch: "feature/login",
            commitSummary: "Repair login",
            diffSummary: "M login.ts",
            diffPatch: "+handleRemoteCallback()",
          }),
        ).toEqual({ title: "Repair Google login", body: "## Summary\nSupport remote callbacks." });
        expect(
          yield* fixture.textGeneration.generateBranchName({
            ...common,
            message: "Repair Google login",
          }),
        ).toEqual({ branch: "repair-google-login" });
        expect(yield* fixture.textGeneration.generateThreadTitle(fixture.titleInput)).toEqual({
          title: "Repair Google login",
        });
        expect(new Set(fixture.state.workspaces).size).toBe(4);
        expect(fixture.state.workspaces).not.toContain(fixture.projectDirectory);
        expect(fixture.state.nativeFilesAtClose).toEqual([true, true, true, true]);
        expect(fixture.state.selectedModes).toEqual(["default", "default", "default", "default"]);
        expect(fixture.state.selectedModels).toEqual(Array(4).fill(modelSelection.model));
        expect(fixture.state.prompts[0]?.prompt).toEqual([
          { type: "text", text: expect.stringContaining("+handleRemoteCallback()") },
        ]);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect.each(["tool_call", "tool_call_update"] as const)(
    "aborts on %s even without a permission request",
    (sessionUpdate) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({
          prompt: ({ emit }) =>
            emit({ sessionUpdate, toolCallId: "tool-1", title: "Read files" }).pipe(
              Effect.andThen(Effect.never),
            ),
        });
        const error = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.flip);
        expect(error.detail).toContain("tool work");
        expect(fixture.state.cancellations).toBe(1);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect("rejects native permission and choice requests instead of answering them", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ prompt: () => Effect.never });
      const child = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.enteredPrompt);
      const reply = yield* fixture.incoming.permission(
        {
          sessionId: SESSION_ID,
          toolCall: { toolCallId: "question-1", title: "Choose a title", kind: "other" },
          options: [
            { optionId: "first-native-choice", name: "Use this title", kind: "allow_once" },
            { optionId: "second-native-choice", name: "Use this title", kind: "allow_once" },
          ],
        },
        requestContext,
      );
      const error = yield* Fiber.join(child).pipe(Effect.flip);
      expect(reply).toEqual({ outcome: { outcome: "cancelled" } });
      expect(error.detail).toContain("permission or user input");
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each(["file", "terminal", "extension"] as const)(
    "denies unexpected %s requests",
    (kind) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ prompt: () => Effect.never });
        const child = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.enteredPrompt);
        const request =
          kind === "file"
            ? fixture.incoming.readFile(
                { sessionId: SESSION_ID, path: "/not-allowed" },
                requestContext,
              )
            : kind === "terminal"
              ? fixture.incoming.createTerminal(
                  { sessionId: SESSION_ID, command: "not-allowed" },
                  requestContext,
                )
              : fixture.incoming.extension("_ask_user", {}, requestContext);
        const denied = yield* request.pipe(Effect.exit);
        expect(Exit.isFailure(denied)).toBe(true);
        const error = yield* Fiber.join(child).pipe(Effect.flip);
        expect(error.detail).toContain("tool or user input");
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect.each([
    { output: "   ", detail: "empty" },
    { output: "No JSON here", detail: "invalid structured output" },
    { output: '{"title":42}', detail: "invalid structured output" },
    { output: "x".repeat(128_001), detail: "output limit" },
  ])("rejects $detail output and closes the runtime", ({ output, detail }) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ outputs: [output] });
      const error = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.flip);
      expect(error.detail).toContain(detail);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect("does not return partial JSON after native cancellation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        prompt: ({ emit }) =>
          emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: '{"title":"Partial title"}' },
          }).pipe(Effect.as({ stopReason: "cancelled" })),
      });
      const error = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.flip);
      expect(error.detail).toContain("cancelled");
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { relativePath: "unexpected.txt", kind: "file" },
    { relativePath: ".agents/skills/unexpected.txt", kind: "file" },
    { relativePath: ".gemini/unexpected", kind: "directory" },
    { relativePath: ".agents/skills", kind: "file" },
    ...(symlinksSupported ? [{ relativePath: ".gemini/skills", kind: "symlink" }] : []),
  ])(
    "rejects an unexpected $kind at $relativePath in its temporary workspace",
    ({ relativePath, kind }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const target =
          kind === "symlink"
            ? yield* fs.makeTempDirectoryScoped({ prefix: "goat-antigravity-link-test-" })
            : undefined;
        const fixture = yield* makeFixture({
          startupSkills: true,
          prompt: ({ cwd, emit }) =>
            Effect.gen(function* () {
              const entry = path.join(cwd, relativePath);
              if (yield* fs.exists(entry).pipe(Effect.orDie)) {
                yield* fs.remove(entry, { recursive: true }).pipe(Effect.orDie);
              }
              yield* (
                target !== undefined
                  ? fs.symlink(target, entry)
                  : kind === "directory"
                    ? fs.makeDirectory(entry)
                    : fs.writeFileString(entry, "unexpected")
              ).pipe(Effect.orDie);
              yield* emit({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: '{"title":"Ignored output"}' },
              });
              return { stopReason: "end_turn" };
            }),
        });
        const error = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.flip);
        expect(error.detail).toContain("wrote files");
        if (target !== undefined) expect(yield* fs.exists(target)).toBe(true);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect("pauses memory on a model the account cannot select", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ memoryRunnerContext: memoryContext });
      const error = yield* fixture.textGeneration.generateMemorySummary!({
        ...memorySummary,
        modelSelection: { ...memorySelection, model: "not-in-the-account" },
      }).pipe(Effect.flip);
      expect(error.detail).toContain("select the Antigravity model");
      expect(error.cause).toEqual(new MemoryGenerationRunnerError({ code: "unavailable" }));
      expect(fixture.state.prompts).toEqual([]);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect("uses the native default without sending GOAT's default selection as a model ID", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* fixture.textGeneration.generateThreadTitle({
        ...fixture.titleInput,
        modelSelection: { ...modelSelection, model: ANTIGRAVITY_DEFAULT_MODEL },
      });
      expect(result).toEqual({ title: "Repair login" });
      expect(fixture.state.selectedModels).toEqual([]);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    {
      name: "hooks.json",
      value: '{"default":{"PreInvocation":[{"command":"do-not-run"}]}}',
      available: false,
    },
    {
      name: "mcp_config.json",
      value: '{"mcpServers":{"server":{"command":"do-not-run"}}}',
      available: false,
    },
    { name: "hooks.json", value: "invalid JSON", available: false },
    { name: "mcp_config.json", value: "x".repeat(64_001), available: false },
    { name: "hooks.json", value: "{}", available: true },
    { name: "hooks.json", value: '{"hooks":{}}', available: true },
    { name: "mcp_config.json", value: '{"mcpServers":{}}', available: true },
  ])("checks $name before starting a helper, available=$available", ({ name, value, available }) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const configDirectory = fixture.path.join(fixture.profileDirectory, "config");
      yield* fixture.fs.makeDirectory(configDirectory, { recursive: true });
      yield* fixture.fs.writeFileString(fixture.path.join(configDirectory, name), value);
      expect(yield* isAntigravityTextGenerationAvailable(fixture.profileDirectory)).toBe(available);
      const result = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.exit);
      expect(Exit.isSuccess(result)).toBe(available);
      expect(fixture.state.workspaces.length).toBe(available ? 1 : 0);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { code: undefined, detail: "Sign in before starting Antigravity." },
    { code: -32000, detail: "Sign in to Antigravity in Settings before you continue." },
    { code: -32603, detail: "Antigravity text generation failed." },
  ])("reports setup and sign-in failure $code safely", ({ code, detail }) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(
        code === undefined
          ? { rejectAdmission: true }
          : {
              prompt: () =>
                Effect.fail(new AcpRequestError({ code, errorMessage: "raw provider text" })),
            },
      );
      const error = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.flip);
      expect(error.detail).toBe(detail);
      if (code === undefined) expect(fixture.state.workspaces).toEqual([]);
      yield* fixture.assertCleaned;
    }).pipe(Effect.scoped),
  );

  it.effect.each(["caller", "sign-out"] as const)(
    "closes all helper resources when stopped by %s",
    (source) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ prompt: () => Effect.never });
        const child = yield* fixture.textGeneration
          .generateThreadTitle(fixture.titleInput)
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.enteredPrompt);
        if (source === "caller") {
          yield* Fiber.interrupt(child);
        } else {
          if (!fixture.state.stop) return yield* Effect.die("No tracked helper to stop.");
          yield* fixture.state.stop;
          yield* Fiber.await(child);
        }
        expect(fixture.state.cancellations).toBe(1);
        yield* fixture.assertCleaned;
      }).pipe(Effect.scoped),
  );

  it.effect("refuses unsafe native session IDs without deleting other files", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ sessionId: "../../user-session" });
      const error = yield* fixture.textGeneration
        .generateThreadTitle(fixture.titleInput)
        .pipe(Effect.flip);
      expect(error.detail).toContain("invalid text helper session ID");
      expect(fixture.state.prompts).toEqual([]);
      expect(yield* fixture.fs.readFileString(`${fixture.sessionBase}.db`)).toBe("helper session");
      expect(fixture.state.closed).toEqual(fixture.state.workspaces);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps native sessions whose metadata belongs to a different workspace", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.fs.writeFileString(`${fixture.sessionBase}.db`, "keep this session");
      const metadata = yield* encodeMetadata({ cwd: fixture.projectDirectory });
      yield* fixture.fs.writeFileString(`${fixture.sessionBase}.meta`, metadata);
      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: SESSION_ID,
        cwd: "different-temporary-workspace",
      });
      expect(yield* fixture.fs.readFileString(`${fixture.sessionBase}.db`)).toBe(
        "keep this session",
      );
      expect(yield* fixture.fs.readFileString(`${fixture.sessionBase}.meta`)).toBe(metadata);
    }).pipe(Effect.scoped),
  );
});

it.effect("retains filesystem services supplied only during construction", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ startupSkills: true }).pipe(
      Effect.provide(NodeServices.layer),
    );
    expect(yield* fixture.textGeneration.generateThreadTitle(fixture.titleInput)).toEqual({
      title: "Repair login",
    });
    yield* fixture.assertCleaned;
  }).pipe(Effect.scoped),
);
