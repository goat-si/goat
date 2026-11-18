import { ProviderInstanceId } from "@goat/contracts";
import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { buildCodexDevelopmentContext } from "../../provider/CodexDeveloperInstructions.ts";

describe("CodexAdapterV2 runtime policy", () => {
  const mcpKeys = ["goat_code_runtime", "goat_code_tools", "goat_code_orchestration_01"];
  it.effect.each([undefined, false, true])(
    "selects native collaboration modes without prompt overrides with hasGoatMcp=%s",
    (hasGoatMcp) =>
      Effect.gen(function* () {
        for (const interactionMode of ["plan", "default"] as const) {
          for (const reasoningEffort of [undefined, "high"] as const) {
            const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
              nativeThreadId: "native-mode-switch",
              codexInput: [{ type: "text", text: "test" }],
              runtimePolicy: { runtimeMode: "full-access", interactionMode, cwd: null },
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
                ...(reasoningEffort === undefined
                  ? {}
                  : { options: [{ id: "reasoningEffort", value: reasoningEffort }] }),
              },
              ...(hasGoatMcp === undefined ? {} : { hasGoatMcp }),
            });

            assert.deepEqual(params.collaborationMode, {
              mode: interactionMode,
              settings: {
                model: "gpt-5.4",
                ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
              },
            });
            assert.equal(params.effort, reasoningEffort);
            // Some Responses providers reject `detailed`; `auto` is the most detailed a model supports.
            assert.equal(params.summary, "auto");
            const context = params.additionalContext;
            assert.deepInclude(context, buildCodexDevelopmentContext());
            for (const key of mcpKeys) {
              assert.equal(context?.[key] !== undefined, hasGoatMcp === true);
            }
          }
        }
      }),
  );

  it.effect("derives concrete Codex turn policies from every GOAT runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.approvalsReviewer, "user");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.approvalsReviewer, "user");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(auto.approvalPolicy, "on-request");
      assert.equal(auto.approvalsReviewer, "auto_review");
      assert.equal(auto.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.equal(fullAccess.approvalsReviewer, "user");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("sends MCP app model context as untrusted Codex context", () =>
    Effect.gen(function* () {
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const appContext = [{ key: "mcp_app_todos_list_todos_item-1", text: "Filtered to overdue" }];
      const alone = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        appContext,
      });
      assert.deepEqual(alone.additionalContext, {
        ...buildCodexDevelopmentContext(),
        "mcp_app_todos_list_todos_item-1": { kind: "untrusted", value: "Filtered to overdue" },
      });
      const withGoat = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        hasGoatMcp: true,
        appContext,
      });
      assert.deepEqual(withGoat.additionalContext?.["mcp_app_todos_list_todos_item-1"], {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.isDefined(withGoat.additionalContext?.["goat_code_runtime"]);
    }),
  );

  it.effect(
    "sends the development discipline on every turn and orchestration only with GOAT MCP",
    () =>
      Effect.gen(function* () {
        const turn = (hasGoatMcp: boolean) =>
          CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId: "native-development-context",
            codexInput: [{ type: "text", text: "fix the bug" }],
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            hasGoatMcp,
          });
        assert.deepEqual((yield* turn(false)).additionalContext, buildCodexDevelopmentContext());
        const withGoat = (yield* turn(true)).additionalContext;
        assert.isDefined(withGoat?.goat_code_development);
        assert.deepInclude(withGoat, buildCodexDevelopmentContext());
        assert.isDefined(withGoat?.goat_code_orchestration_01);
      }),
  );
  it.effect("sends the chosen cyber access program, else the model's default", () =>
    Effect.gen(function* () {
      const build = (value?: string, cyberAccess?: { defaultProgram: string | undefined }) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-cyber",
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            ...(value === undefined ? {} : { options: [{ id: "cyberAccessProgram", value }] }),
          },
          cyberAccess,
        });

      // Custom models offer no Cyber Access, so even an explicit choice is dropped.
      assert.notProperty(yield* build(), "cyberAccessProgram");
      assert.notProperty(yield* build("daybreakBlue"), "cyberAccessProgram");
      const daybreak = { defaultProgram: "daybreakBlue" };
      assert.equal((yield* build(undefined, daybreak)).cyberAccessProgram, "daybreakBlue");
      assert.equal((yield* build("standard", daybreak)).cyberAccessProgram, "standard");
      // An unread config leaves no default, but an explicit Standard still goes.
      const unknown = { defaultProgram: undefined };
      assert.notProperty(yield* build(undefined, unknown), "cyberAccessProgram");
      assert.equal((yield* build("standard", unknown)).cyberAccessProgram, "standard");
    }),
  );
});
