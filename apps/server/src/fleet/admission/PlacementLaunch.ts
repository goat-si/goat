import {
  type ChatAttachment,
  type CommandId,
  OrchestratorMcpFailure,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import {
  ThreadLaunchParameters,
  type ThreadLaunchSuccess,
} from "../../mcp/toolkits/project/tools.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { type PlacementAnswer, PlacementAdmission } from "./PlacementAdmission.ts";
import { placementDigest } from "./PlacementDigest.ts";
import { issuedAtMillis, PlacementAdmissionEnabled } from "./PlacementKey.ts";

type LaunchParameters = typeof ThreadLaunchParameters.Type & {
  readonly clientRequestId?: string | undefined;
};
type LaunchSuccess = typeof ThreadLaunchSuccess.Type;

/** The placer is the session's Pen binding, set by the session layer; anything else is this machine's own. */
export const placerOf = (scope: McpInvocationContext.McpInvocationScope): string =>
  scope.client?.pen === undefined ? "local" : "pen:" + scope.client.pen.nodeId;

const principalOf = (scope: McpInvocationContext.McpInvocationScope) => ({
  kind:
    scope.client?.pen !== undefined
      ? "pen"
      : scope.client !== undefined
        ? "outside_client"
        : "thread",
  runtimeCeiling: McpInvocationContext.clientRuntimeModeCeiling(scope.client),
});

const refusal = (
  classification: string,
  message: string,
  extra: {
    readonly mayHaveStarted?: boolean;
    readonly threadId?: string;
    readonly code?: OrchestratorMcpFailure["code"];
  } = {},
) =>
  new OrchestratorMcpFailure({
    code: extra.code ?? "conflict",
    message,
    classification,
    mayHaveStarted: extra.mayHaveStarted ?? false,
    ...(extra.threadId === undefined ? {} : { threadId: extra.threadId }),
  });

/** Every answer except a started one, as the placer reads it. */
export const refusalForAnswer = (
  answer: Exclude<PlacementAnswer, { readonly _tag: "Started" }>,
) => {
  switch (answer._tag) {
    case "NotStarted":
      return refusal(
        "placement_not_started",
        "This placement did not start here: " + answer.reason + ".",
        answer.threadId === null ? {} : { threadId: answer.threadId },
      );
    case "Conflicting":
      return refusal(
        "placement_conflicting",
        "This placement key was already used here for a different launch.",
        { mayHaveStarted: true },
      );
    case "Pending":
      return refusal(
        "placement_pending",
        "This placement is still being launched here; retry the same key to learn its outcome.",
        { mayHaveStarted: true },
      );
    case "StoreUnavailable":
      return refusal(
        "placement_store_unavailable",
        "This machine cannot read its placement records now.",
        {
          mayHaveStarted: true,
          code: "orchestration_error",
        },
      );
    case "Refused":
      switch (answer.refusal) {
        case "full":
          return refusal("placement_full", "This machine is at its thread limit.", {
            code: "capacity_exceeded",
          });
        case "cordoned":
          return refusal(
            "placement_cordoned",
            "This machine is cordoned and takes no new placements.",
            {
              code: "capacity_exceeded",
            },
          );
        case "placer_bound":
          return refusal(
            "placement_placer_bound",
            "This placer has too many unexpired placements on this machine.",
            { code: "capacity_exceeded" },
          );
        case "future":
          return refusal(
            "placement_future",
            "This placement key is from the future by this machine's clock.",
            {
              code: "invalid_request",
            },
          );
        case "expired":
          return refusal(
            "placement_expired",
            "This placement key has expired here; its outcome is not known on this machine.",
            { mayHaveStarted: true },
          );
      }
  }
};

export interface PlacementTargetShape {
  /** Admits a placed goat_thread_launch, or answers a retry of its key from the reservation row. */
  readonly launch: (
    scope: McpInvocationContext.McpInvocationScope,
    input: LaunchParameters,
    launch: (commandId: CommandId) => Effect.Effect<LaunchSuccess, OrchestratorMcpFailure>,
  ) => Effect.Effect<LaunchSuccess, OrchestratorMcpFailure>;
}

export class PlacementTarget extends Context.Service<PlacementTarget, PlacementTargetShape>()(
  "goat/fleet/admission/PlacementLaunch/PlacementTarget",
) {}

const FIELD_NAMES = [...Object.keys(ThreadLaunchParameters.fields), "clientRequestId"];

const make = Effect.gen(function* () {
  const admission = yield* PlacementAdmission;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const enabled = yield* PlacementAdmissionEnabled;

  const attachmentBytes = (attachment: ChatAttachment) => {
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    return path === null
      ? Effect.succeed(null)
      : fileSystem.readFile(path).pipe(Effect.orElseSucceed(() => null));
  };

  /** A retry that did not run the launch is answered from the thread as it is now. */
  const startedFromThread = Effect.fn("PlacementTarget.startedFromThread")(function* (
    threadId: string,
    runId: string,
  ) {
    const { thread, runs } = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["runs"], { runIds: [RunId.make(runId)] })
      .pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "This placement started, but its thread cannot be read now.",
              mayHaveStarted: true,
            }),
        ),
      );
    return {
      threadId: thread.id,
      projectId: thread.projectId,
      modelSelection: thread.modelSelection,
      runId: RunId.make(runId),
      status: runs.find((run) => run.id === runId)?.status ?? null,
      watching: false,
      standingInstructionsVersion: null,
    } satisfies LaunchSuccess;
  });

  const launch: PlacementTargetShape["launch"] = Effect.fn("PlacementTarget.launch")(
    function* (scope, input, run) {
      const placement = input.placement;
      if (placement === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "No placement given.",
        });
      if (!enabled)
        return yield* refusal("placement_off", "This machine does not admit placements.", {
          code: "invalid_request",
        });
      if (scope.thread !== undefined || scope.client === undefined)
        return yield* refusal(
          "placement_invalid",
          "Only another GOAT signed in as a client may place work.",
          {
            code: "invalid_request",
          },
        );
      if (input.references !== undefined && input.references.length > 0)
        return yield* refusal(
          "placement_invalid",
          "A placed launch cannot carry repository references.",
          {
            code: "invalid_request",
          },
        );
      if (input.message === undefined || input.message.trim() === "")
        return yield* refusal("placement_no_message", "A placed launch needs a message.", {
          code: "invalid_request",
        });
      const issuedAt = issuedAtMillis(placement.issuedAt);
      if (issuedAt === undefined)
        return yield* refusal(
          "placement_invalid",
          "placement.issuedAt is not an ISO-8601 UTC instant.",
          {
            code: "invalid_request",
          },
        );
      const digest = yield* placementDigest({
        parameters: input,
        fieldNames: FIELD_NAMES,
        principal: principalOf(scope),
        attachmentBytes,
      }).pipe(
        Effect.catchTags({
          PlacementAttachmentUnavailable: (error) =>
            Effect.fail(
              refusal(
                "placement_attachment_unavailable",
                "Attachment '" +
                  error.name +
                  "' is not stored here; upload it again and retry the same key.",
                { mayHaveStarted: true, code: "invalid_request" },
              ),
            ),
        }),
      );
      const answer = yield* admission.place({
        key: {
          placer: placerOf(scope),
          ownerKey: placement.ownerKey,
          attempt: placement.attempt,
          issuedAt,
        },
        digest,
        launch: run,
      });
      if (answer._tag !== "Started") return yield* refusalForAnswer(answer);
      const launched = answer.launched as LaunchSuccess | undefined;
      const success = launched ?? (yield* startedFromThread(answer.threadId, answer.runId));
      return { ...success, placement: { outcome: "started" as const } };
    },
  );

  return PlacementTarget.of({ launch });
});

export const layer = Layer.effect(PlacementTarget, make);

/** The handler's entry: without a PlacementTarget in context, placement is off here. */
export const launchPlaced = (
  scope: McpInvocationContext.McpInvocationScope,
  input: LaunchParameters,
  launch: Parameters<PlacementTargetShape["launch"]>[2],
) =>
  Effect.flatMap(Effect.serviceOption(PlacementTarget), (target) =>
    Option.isNone(target)
      ? Effect.fail(
          refusal("placement_off", "This machine does not admit placements.", {
            code: "invalid_request",
          }),
        )
      : target.value.launch(scope, input, launch),
  );
