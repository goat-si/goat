import type { RuntimeMode, ServerProviderModel } from "@goat/contracts";
import * as MemoryContext from "@goat/provider-core/server/memoryContext";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { getModelSelectionStringOptionValue } from "@goat/shared/model";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import {
  buildCodexAdditionalContext,
  buildCodexDevelopmentContext,
} from "../../provider/CodexDeveloperInstructions.ts";
import { codexDefaultReasoningEffortOverride } from "../../provider/CodexProvider.ts";
import { CUA_DEFERRED_NOTE, RESTART_RELOAD_NOTE } from "./codexThreadStatuses.ts";
import type { CodexTurnStartInput } from "./CodexTurnStartInput.ts";

const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);
const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);
const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(
      Schema.Record(Schema.String, CodexSchema.V2TurnStartParams__AdditionalContextEntry),
    ),
    cyberAccessProgram: Schema.optionalKey(CodexSchema.V2TurnStartParams__CyberAccessProgram),
  }),
);
type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);
const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);

function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
  }
}

const isCodexCyberAccessProgram = Schema.is(CodexSchema.V2TurnStartParams__CyberAccessProgram);

function codexCyberAccess(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
): { readonly defaultProgram: string | undefined } | undefined {
  const descriptor = models
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.find((candidate) => candidate.id === "cyberAccessProgram");
  return descriptor?.type === "select" ? { defaultProgram: descriptor.currentValue } : undefined;
}

export const buildCodexTurnStartParams = Effect.fn("CodexAdapterV2.buildCodexTurnStartParams")(
  function* (input: CodexTurnStartInput) {
    const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? runtimeModeDefaults.approvalPolicy
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? runtimeModeDefaults.sandboxPolicy
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const selectedEffort =
      getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort") ??
      codexDefaultReasoningEffortOverride(input.modelSelection.model);
    const effort =
      selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
    const serviceTier =
      input.omitServiceTier === true
        ? undefined
        : getCodexServiceTierOptionValue(input.modelSelection);
    // A chosen program goes as is, even one the model lacks, so Codex rejects it visibly.
    const cyberAccessProgram =
      input.cyberAccess === undefined
        ? undefined
        : [
            getModelSelectionStringOptionValue(input.modelSelection, "cyberAccessProgram"),
            input.cyberAccess.defaultProgram,
          ].find(isCodexCyberAccessProgram);
    // MCP-written app context must be quoted user input, not developer instructions.
    const appContext = Object.fromEntries(
      (input.appContext ?? [])
        .filter((entry) => entry.key !== "goat_memory")
        .map((entry) => [entry.key, { kind: "untrusted" as const, value: entry.text }]),
    );
    const goatContext =
      input.hasGoatMcp === true
        ? buildCodexAdditionalContext(
            { model: input.modelSelection.model, reasoningEffort: effort ?? undefined },
            {
              browser: input.browserToolsAvailable ?? true,
              device: input.deviceToolsAvailable ?? false,
              computerUse: input.computerUse ?? false,
              screenCode: input.screenCode ?? false,
              screenCodeSkillPath: input.screenCodeSkillPath,
            },
          )
        : buildCodexDevelopmentContext();
    const memoryContext =
      input.memoryContext === undefined
        ? input.clearMemoryContext
          ? { goat_memory: { kind: "untrusted" as const, value: "" } }
          : {}
        : {
            goat_memory: {
              kind: "untrusted" as const,
              value: (yield* Effect.try(() =>
                MemoryContext.validateMemoryContext(input.memoryContext),
              )).renderedText,
            },
          };
    const deferredContext = input.computerUseDeferred
      ? { goat_computer_use_deferred: { kind: "application" as const, value: CUA_DEFERRED_NOTE } }
      : {};
    const restartContext = input.reloadedAfterRestart
      ? { goat_restart_reload: { kind: "application" as const, value: RESTART_RELOAD_NOTE } }
      : {};
    const additionalContext = {
      ...goatContext,
      ...deferredContext,
      ...restartContext,
      ...appContext,
      ...memoryContext,
    };

    return yield* decodeCodexTurnStartParamsWithCollaborationMode({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(additionalContext ? { additionalContext } : {}),
      cwd: input.runtimePolicy.cwd,
      model: input.modelSelection.model,
      // Catalogues can default summaries to "none", and turn/start overrides the user's config,
      // so pass theirs through or `auto`: some providers (Amazon Bedrock) reject `detailed`.
      summary: input.configuredReasoningSummary ?? "auto",
      // Omitting the reviewer on resume preserves the previous Auto reviewer.
      approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
      ...(effort === undefined ? {} : { effort }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      // Codex keeps no per-thread choice for this, so every turn must carry it.
      ...(cyberAccessProgram === undefined ? {} : { cyberAccessProgram }),
      // Codex supplies its own mode instructions; send both modes to clear Plan on exit.
      collaborationMode: {
        mode: input.runtimePolicy.interactionMode,
        settings: {
          model: input.modelSelection.model,
          ...(effort === undefined ? {} : { reasoning_effort: effort }),
        },
      },
    });
  },
);

export {
  codexCyberAccess,
  type CodexTurnStartParamsWithCollaborationMode,
  isProviderAdapterRuntimeRequestResponseError,
};
