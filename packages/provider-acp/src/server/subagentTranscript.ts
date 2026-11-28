import type {
  MessageId,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import { mcpToolPresentation } from "@goat/provider-core/server/mcpToolPresentation";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeSubagentConversationArtifacts } from "@goat/provider-core/server/subagentProjection";
import { isWorkspaceImagePreviewPath } from "@goat/shared/mediaPreview";
import { formatReadToolLabel, formatSearchToolLabel } from "@goat/shared/toolActivity";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { acpSubagentStatusBlocksTurnSettlement } from "./acpSubagentStatus.ts";
import type { AcpCarryoverSubagents, ActiveAcpSubagent, ActiveAcpTurn } from "./activeTurn.ts";
import type { AcpAdapterV2Flavor } from "./adapterFlavor.ts";
import { nonEmptyText } from "./adapterIdentity.ts";
import { unknownRecord } from "./clientPolicy.ts";
import { extractMcpToolCallIdentity, type AcpToolCallState } from "./runtimeModel.ts";
import {
  completedAtForStatus,
  toolStatus,
  type ProjectedToolStatus,
} from "./subagentToolProjection.ts";
import {
  acpToolCallDiffPatch,
  acpToolCallDiffUnpreviewable,
  acpToolCallSnippetEdit,
  structuredFileChanges,
} from "./toolDiff.ts";
import { textFromUnknown } from "./toolOutputText.ts";
import {
  acpBackendWebSearch,
  acpMcpToolCallOutput,
  acpProjectedCommandExitCode,
  commandExitCode,
  pathFromToolCall,
  resolvedPathInfo,
  webSearchLabel,
} from "./toolProjection.ts";

export type AcpSubagentTranscriptEntry = (
  | {
      readonly kind: "reasoning";
      readonly itemId: string;
      readonly text: string;
      readonly status: "running" | "completed";
      readonly title?: string | null | undefined;
      readonly createdAt?: DateTime.Utc | undefined;
    }
  | {
      readonly kind: "tool";
      readonly itemId: string;
      readonly toolCall: AcpToolCallState;
      readonly projectedStatus?: "interrupted" | undefined;
      readonly createdAt?: DateTime.Utc | undefined;
    }
  | {
      readonly kind: "assistant_message";
      readonly itemId: string;
      readonly text: string;
      readonly createdAt?: DateTime.Utc | undefined;
    }
  | {
      readonly kind: "user_message";
      readonly itemId: string;
      readonly text: string;
      readonly createdAt?: DateTime.Utc | undefined;
    }
  | {
      readonly kind: "error";
      readonly itemId: string;
      readonly message: string;
      readonly createdAt?: DateTime.Utc | undefined;
    }
) & {
  /** Names the transcript an entry came from when one subagent call runs several children. */
  readonly childKey?: string | undefined;
};

const encodeFingerprintJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ACP_SUBAGENT_TRANSCRIPT_POLL_MS = [1_000, 2_000, 5_000] as const;
// A subagent can report idle to its parent before its transcript records the closing reply.
const ACP_SUBAGENT_TRAILING_DRAIN_POLL_MS = [
  500, 1_000, 1_500, 2_000, 2_000, 3_000, 4_000, 5_000, 5_000, 6_000,
] as const;

function acpSubagentTranscriptEntryFingerprint(entry: AcpSubagentTranscriptEntry): string {
  switch (entry.kind) {
    case "reasoning":
      return encodeFingerprintJson([entry.kind, entry.status, entry.title ?? null, entry.text]);
    case "assistant_message":
    case "user_message":
      return encodeFingerprintJson([entry.kind, entry.text]);
    case "error":
      return encodeFingerprintJson([entry.kind, entry.message]);
    case "tool":
      return encodeFingerprintJson([
        entry.kind,
        entry.projectedStatus ?? null,
        entry.toolCall.status ?? null,
        entry.toolCall.kind ?? null,
        entry.toolCall.title ?? null,
        entry.toolCall.command ?? null,
        entry.toolCall.data,
      ]);
  }
}

// Every child's transcript ends in a reply, so no closing reply is still to come.
function subagentTranscriptRepliesSettled(subagent: ActiveAcpSubagent): boolean {
  const kinds = [...subagent.lastTranscriptEntryKinds.values()];
  return kinds.length > 0 && kinds.every((kind) => kind === "assistant_message");
}

export function buildAcpStandardToolTurnItem(input: {
  readonly base: {
    readonly id: OrchestrationV2TurnItem["id"];
    readonly threadId: ThreadId;
    readonly runId: OrchestrationV2TurnItem["runId"];
    readonly nodeId: OrchestrationV2TurnItem["nodeId"];
    readonly providerThreadId: ProviderThreadId | null;
    readonly providerTurnId: OrchestrationV2TurnItem["providerTurnId"];
    readonly nativeItemRef: OrchestrationV2TurnItem["nativeItemRef"];
    readonly parentItemId: null;
    readonly ordinal: number;
    readonly status: ProjectedToolStatus;
    readonly title: string | null;
    readonly startedAt: DateTime.Utc;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  };
  readonly toolCall: AcpToolCallState;
  readonly status: ProjectedToolStatus;
  readonly title: string | null;
  readonly rawInput: unknown;
  readonly rawInputRecord: Record<string, unknown> | undefined;
  readonly rawOutput: unknown;
  readonly changes: ReturnType<typeof structuredFileChanges>;
  readonly path: string | undefined;
  readonly diffText: string | undefined;
  readonly monitorCommand: string | undefined;
  readonly projectAsCommandExecution: boolean;
  readonly inputVariant: string;
}): OrchestrationV2TurnItem {
  const {
    base,
    toolCall,
    status,
    title,
    rawInput,
    rawInputRecord,
    rawOutput,
    changes,
    path,
    diffText,
    monitorCommand,
    projectAsCommandExecution,
    inputVariant,
  } = input;
  const firstChange = changes[0];
  if (firstChange !== undefined) {
    return {
      ...base,
      type: "file_change",
      fileName: firstChange.path,
      changes,
      ...(diffText === undefined ? {} : { diffStr: diffText }),
    };
  }
  switch (toolCall.kind) {
    case "read":
      return {
        ...base,
        title: path ? formatReadToolLabel(path) : (title ?? "Read file"),
        type: "dynamic_tool",
        toolName: "Read",
        ...(path !== undefined &&
        path.length <= 4096 &&
        !/[\r\n]/.test(path) &&
        isWorkspaceImagePreviewPath(path)
          ? { viewedImagePath: path }
          : {}),
        input:
          path === undefined ||
          ["path", "filePath", "file_path"].some((key) => rawInputRecord?.[key] === path)
            ? (rawInputRecord ?? {})
            : { ...rawInputRecord, path },
        ...(rawOutput === undefined ? {} : { output: rawOutput }),
      };
    case "search": {
      const backendSearch = acpBackendWebSearch(
        rawInputRecord,
        rawOutput,
        typeof toolCall.data.title === "string" ? toolCall.data.title : title,
      );
      if (backendSearch !== undefined) {
        const label = webSearchLabel(nonEmptyText(toolCall.data.title, title ?? "Web search"));
        return {
          ...base,
          title: backendSearch.query === undefined ? label : `${label}: ${backendSearch.query}`,
          type: "web_search",
          ...(backendSearch.query === undefined ? {} : { patterns: [backendSearch.query] }),
          ...(backendSearch.results.length === 0 ? {} : { results: backendSearch.results }),
        };
      }
      const pathIsQuery = resolvedPathInfo(toolCall)?.fromQuery === true;
      const searchOutput = textFromUnknown(rawOutput);
      return {
        ...base,
        title:
          formatSearchToolLabel({
            rawInput: rawInputRecord,
            input: rawInputRecord,
            ...(path === undefined ? {} : { pattern: path }),
          }) ?? title,
        type: "file_search",
        ...(path === undefined ? {} : { pattern: path }),
        ...(path === undefined || (pathIsQuery && searchOutput === undefined)
          ? {}
          : {
              results: [
                {
                  fileName: path,
                  ...(searchOutput === undefined ? {} : { preview: searchOutput }),
                },
              ],
            }),
      };
    }
    case "execute": {
      const exitCode = acpProjectedCommandExitCode(status, rawOutput);
      const output = textFromUnknown(rawOutput);
      return {
        ...base,
        type: "command_execution",
        input: toolCall.command ?? monitorCommand ?? "",
        ...(output === undefined ? {} : { output }),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const snippet = acpToolCallSnippetEdit(toolCall.data.content);
      const unpreviewable = acpToolCallDiffUnpreviewable(toolCall.data.content);
      return {
        ...base,
        type: "file_change",
        fileName: path ?? toolCall.title ?? "File change",
        ...(snippet ?? (unpreviewable || diffText === undefined ? {} : { diffStr: diffText })),
      };
    }
    case "fetch": {
      // Grok rawOutput.Content is unreadable by textFromUnknown; bounded content blocks duplicate it.
      const snippet = textFromUnknown(toolCall.data.content) ?? textFromUnknown(rawOutput);
      return {
        ...base,
        type: "web_search",
        ...(path === undefined ? {} : { patterns: [path] }),
        ...(path === undefined
          ? {}
          : {
              results: [
                {
                  url: path,
                  ...(snippet === undefined ? {} : { snippet }),
                },
              ],
            }),
      };
    }
    default:
      if (projectAsCommandExecution) {
        const exitCode = acpProjectedCommandExitCode(status, rawOutput);
        const output = textFromUnknown(rawOutput);
        return {
          ...base,
          type: "command_execution",
          input: toolCall.command ?? monitorCommand ?? "",
          ...(output === undefined ? {} : { output }),
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(inputVariant === "monitor" ? { monitor: true } : {}),
        };
      }
      return {
        ...base,
        type: "dynamic_tool",
        toolName: toolCall.title ?? toolCall.kind ?? null,
        input: rawInput ?? {},
        ...(rawOutput === undefined ? {} : { output: rawOutput }),
      };
  }
}

export function makeAcpSubagentTranscriptController(deps: {
  readonly driver: ProviderDriverKind;
  readonly flavor: Pick<AcpAdapterV2Flavor, "readSubagentTranscript">;
  readonly sessionScope: Scope.Scope;
  readonly activeTurn: Ref.Ref<ActiveAcpTurn | null>;
  readonly carryoverSubagents: Ref.Ref<AcpCarryoverSubagents | null>;
  readonly providerMessageId: (nativeItemId: string) => MessageId;
  readonly providerTurnItemId: (nativeItemId: string) => TurnItemId;
  readonly resolveSubagentChildOrdinal: (
    subagent: ActiveAcpSubagent,
    nativeItemId: string,
  ) => number;
  readonly emitProviderEvent: (
    event: ProviderAdapter.ProviderAdapterV2Event,
  ) => Effect.Effect<void>;
}) {
  // Reported through hasPendingBackgroundWorkForThread so the run keeps ingesting their replies.
  const trailingTranscriptDrains = new Set<ActiveAcpSubagent>();

  const projectEntry = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    entry: AcpSubagentTranscriptEntry,
  ) {
    const fingerprint = acpSubagentTranscriptEntryFingerprint(entry);
    if (subagent.transcriptEntryFingerprints.get(entry.itemId) === fingerprint) {
      return false;
    }
    subagent.transcriptEntryFingerprints.set(entry.itemId, fingerprint);
    const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
    const nativeItemId = `${subagent.rootSessionId}:${nativeTaskId}:transcript:${entry.itemId}`;
    const now = yield* DateTime.now;
    const startedAt = subagent.transcriptStartedAt.get(entry.itemId) ?? entry.createdAt ?? now;
    subagent.transcriptStartedAt.set(entry.itemId, startedAt);
    const ordinal = deps.resolveSubagentChildOrdinal(subagent, nativeItemId);
    const nativeItemRef = {
      driver: deps.driver,
      nativeId: nativeItemId,
      strength: "strong" as const,
    };

    switch (entry.kind) {
      case "reasoning": {
        if (entry.status === "running") {
          subagent.transcriptOpenEntries.set(entry.itemId, entry);
        } else {
          subagent.transcriptOpenEntries.delete(entry.itemId);
        }
        yield* deps.emitProviderEvent({
          type: "turn_item.updated",
          driver: deps.driver,
          turnItem: {
            id: deps.providerTurnItemId(nativeItemId),
            threadId: subagent.childThreadId,
            runId: null,
            nodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: entry.status,
            title: entry.title ?? "Thinking",
            startedAt,
            completedAt: entry.status === "completed" ? now : null,
            updatedAt: now,
            type: "reasoning",
            text: entry.text,
            streaming: entry.status === "running",
          },
        });
        return true;
      }
      case "assistant_message": {
        const artifacts = makeSubagentConversationArtifacts({
          messageId: deps.providerMessageId(nativeItemId),
          turnItemId: deps.providerTurnItemId(nativeItemId),
          threadId: subagent.childThreadId,
          rootNodeId: subagent.childRootNodeId,
          providerThreadId: subagent.task.providerThreadId,
          providerTurnId: null,
          nativeItemRef: { driver: deps.driver, nativeId: nativeItemId, strength: "weak" },
          role: "assistant",
          text: entry.text,
          ordinal,
          now: entry.createdAt ?? now,
        });
        subagent.assistantMessages.set(nativeItemId, entry.text);
        subagent.assistantText = entry.text;
        yield* deps.emitProviderEvent({
          type: "message.updated",
          driver: deps.driver,
          message: artifacts.message,
        });
        yield* deps.emitProviderEvent({
          type: "turn_item.updated",
          driver: deps.driver,
          turnItem: artifacts.turnItem,
        });
        return true;
      }
      case "user_message": {
        const artifacts = makeSubagentConversationArtifacts({
          senderThreadId: subagent.task.threadId,
          messageId: deps.providerMessageId(nativeItemId),
          turnItemId: deps.providerTurnItemId(nativeItemId),
          threadId: subagent.childThreadId,
          rootNodeId: subagent.childRootNodeId,
          providerThreadId: subagent.task.providerThreadId,
          providerTurnId: null,
          nativeItemRef: { driver: deps.driver, nativeId: nativeItemId, strength: "weak" },
          role: "user",
          text: entry.text,
          ordinal,
          now: entry.createdAt ?? now,
        });
        yield* deps.emitProviderEvent({
          type: "message.updated",
          driver: deps.driver,
          message: artifacts.message,
        });
        yield* deps.emitProviderEvent({
          type: "turn_item.updated",
          driver: deps.driver,
          turnItem: artifacts.turnItem,
        });
        return true;
      }
      case "error": {
        yield* deps.emitProviderEvent({
          type: "turn_item.updated",
          driver: deps.driver,
          turnItem: {
            id: deps.providerTurnItemId(nativeItemId),
            threadId: subagent.childThreadId,
            runId: null,
            nodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "failed",
            title: null,
            startedAt,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure: makeProviderFailure({
              class: "provider_error",
              message: entry.message,
            }),
          },
        });
        return true;
      }
      case "tool": {
        const toolCall = entry.toolCall;
        const status = entry.projectedStatus ?? toolStatus(toolCall.status);
        if (status === "running" || status === "pending" || status === "waiting") {
          subagent.transcriptOpenEntries.set(entry.itemId, entry);
        } else {
          subagent.transcriptOpenEntries.delete(entry.itemId);
        }
        const completedAt = completedAtForStatus(status, now);
        const title = toolCall.title ?? null;
        const base = {
          id: deps.providerTurnItemId(nativeItemId),
          threadId: subagent.childThreadId,
          runId: null,
          nodeId: subagent.childRootNodeId,
          providerThreadId: subagent.task.providerThreadId,
          providerTurnId: null,
          nativeItemRef,
          parentItemId: null,
          ordinal,
          status,
          title,
          startedAt,
          completedAt,
          updatedAt: now,
        } as const;
        const rawInput = toolCall.data.rawInput;
        const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
        const changes = structuredFileChanges(toolCall);
        const path = changes[0]?.path ?? pathFromToolCall(toolCall);
        const diffText = acpToolCallDiffPatch(toolCall.data.content) ?? textFromUnknown(rawOutput);
        const rawInputRecord = unknownRecord(rawInput);
        const inputVariant =
          typeof rawInputRecord?.variant === "string"
            ? rawInputRecord.variant.trim().toLowerCase()
            : "";
        const rawOutputRecord = unknownRecord(rawOutput);
        const outputCommand =
          typeof rawOutputRecord?.command === "string" && rawOutputRecord.command.trim().length > 0
            ? rawOutputRecord.command.trim()
            : undefined;
        const monitorCommand =
          (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
            ? rawInputRecord.command.trim()
            : undefined) ?? outputCommand;
        const outputIsBashResult =
          typeof rawOutputRecord?.type === "string" &&
          rawOutputRecord.type.trim().toLowerCase() === "bash" &&
          commandExitCode(rawOutput) !== undefined;
        const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
        const mcpIdentity = extractMcpToolCallIdentity(toolCall);
        const turnItem: OrchestrationV2TurnItem =
          mcpIdentity !== undefined
            ? {
                ...base,
                ...mcpToolPresentation({
                  serverName: mcpIdentity.server,
                  toolName: mcpIdentity.tool,
                  source: unknownRecord(
                    (unknownRecord(rawOutputRecord?.result) ?? rawOutputRecord)?._meta,
                  )?.source,
                }),
                type: "dynamic_tool",
                toolName: `${mcpIdentity.server}.${mcpIdentity.tool}`,
                input:
                  mcpIdentity.input ??
                  unknownRecord(rawInputRecord?.arguments) ??
                  rawInputRecord ??
                  {},
                ...(rawOutput === undefined ? {} : { output: acpMcpToolCallOutput(rawOutput) }),
              }
            : buildAcpStandardToolTurnItem({
                base,
                toolCall,
                status,
                title,
                rawInput,
                rawInputRecord,
                rawOutput,
                changes,
                path,
                diffText,
                monitorCommand,
                projectAsCommandExecution,
                inputVariant,
              });
        yield* deps.emitProviderEvent({
          type: "turn_item.updated",
          driver: deps.driver,
          turnItem,
        });
        return true;
      }
    }
  });

  const subagentSiblings = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent) {
    const selfNativeId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
    const active = yield* Ref.get(deps.activeTurn);
    const carryover = yield* Ref.get(deps.carryoverSubagents);
    const pool = [...(active?.subagents.values() ?? []), ...(carryover?.subagents ?? [])];
    const seen = new Set<string>([selfNativeId]);
    const siblings: Array<{
      readonly nativeTaskId: string;
      readonly title: string | null;
      readonly prompt: string;
    }> = [];
    for (const candidate of pool) {
      if (candidate.rootSessionId !== subagent.rootSessionId) continue;
      const nativeTaskId = candidate.task.nativeTaskRef?.nativeId ?? String(candidate.task.id);
      if (seen.has(nativeTaskId)) continue;
      seen.add(nativeTaskId);
      siblings.push({
        nativeTaskId,
        title: candidate.task.title,
        prompt: candidate.task.prompt,
      });
    }
    return siblings;
  });

  const drain = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent, finalize: boolean) {
    const readTranscript = deps.flavor.readSubagentTranscript;
    if (readTranscript === undefined) return false;
    return yield* subagent.transcriptDrainPermit.withPermit(
      Effect.gen(function* () {
        const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
        const siblings = yield* subagentSiblings(subagent);
        const entries = yield* readTranscript({
          sessionId: subagent.rootSessionId,
          nativeTaskId,
          childSessionId: subagent.childSessionId,
          launch: { title: subagent.task.title, prompt: subagent.task.prompt },
          siblings,
          finalize,
        }).pipe(
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<AcpSubagentTranscriptEntry>)),
        );
        let changed = false;
        const seenIds = new Set<string>();
        for (const entry of entries) {
          seenIds.add(entry.itemId);
          if (yield* projectEntry(subagent, entry)) {
            changed = true;
          }
        }
        if (entries.length > 0) {
          for (const entry of entries) {
            subagent.lastTranscriptEntryKinds.set(entry.childKey ?? "", entry.kind);
          }
        }
        if (finalize && subagent.transcriptOpenEntries.size > 0) {
          // Settle open entries that scrolled out of the transcript tail cap before finishing.
          for (const [itemId, openEntry] of subagent.transcriptOpenEntries) {
            if (seenIds.has(itemId)) continue;
            const settled: AcpSubagentTranscriptEntry =
              openEntry.kind === "reasoning"
                ? { ...openEntry, status: "completed" }
                : openEntry.kind === "tool"
                  ? {
                      ...openEntry,
                      toolCall: { ...openEntry.toolCall, status: "failed" },
                      projectedStatus: "interrupted",
                    }
                  : openEntry;
            if (yield* projectEntry(subagent, settled)) {
              changed = true;
            }
            subagent.transcriptOpenEntries.delete(itemId);
          }
        }
        return changed;
      }),
    );
  });

  const stopFollower = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent) {
    const stop = subagent.transcriptFollowerStop;
    if (stop !== undefined) {
      yield* Deferred.succeed(stop, undefined).pipe(Effect.ignore);
    }
    const trailingStop = subagent.transcriptTrailingDrainStop;
    if (trailingStop !== undefined) {
      yield* Deferred.succeed(trailingStop, undefined).pipe(Effect.ignore);
    }
  });

  // Starts before the terminal status is emitted, so the run never sees it without this drain pending.
  const startTrailingDrain = Effect.fnUntraced(function* (
    subagent: ActiveAcpSubagent,
    status: OrchestrationV2Subagent["status"],
  ) {
    if (
      deps.flavor.readSubagentTranscript === undefined ||
      subagent.transcriptTrailingDrainStarted ||
      (status !== "idle" && status !== "completed") ||
      subagentTranscriptRepliesSettled(subagent)
    ) {
      return;
    }
    subagent.transcriptTrailingDrainStarted = true;
    trailingTranscriptDrains.add(subagent);
    const stop = yield* Deferred.make<void>();
    subagent.transcriptTrailingDrainStop = stop;
    yield* Effect.gen(function* () {
      for (const pollMs of ACP_SUBAGENT_TRAILING_DRAIN_POLL_MS) {
        const stopped = yield* Deferred.await(stop).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: Duration.millis(pollMs),
            orElse: () => Effect.succeed(false),
          }),
        );
        if (stopped) break;
        if (subagent.task.status !== "idle" && subagent.task.status !== "completed") break;
        const changed = yield* drain(subagent, true);
        if (changed && subagent.task.result === null && subagent.assistantText.length > 0) {
          const now = yield* DateTime.now;
          subagent.task = {
            ...subagent.task,
            result: subagent.assistantText,
            updatedAt: now,
          };
          yield* deps.emitProviderEvent({
            type: "subagent.updated",
            driver: deps.driver,
            subagent: subagent.task,
          });
        }
        if (subagentTranscriptRepliesSettled(subagent)) break;
      }
    }).pipe(
      Effect.ignoreCause,
      // Re-emitting the settled subagent makes the run re-check its pending work.
      Effect.ensuring(
        Effect.suspend(() => {
          trailingTranscriptDrains.delete(subagent);
          return deps.emitProviderEvent({
            type: "subagent.updated",
            driver: deps.driver,
            subagent: subagent.task,
          });
        }).pipe(Effect.ignoreCause),
      ),
      Effect.forkIn(deps.sessionScope),
    );
  });

  const startFollower = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent) {
    if (deps.flavor.readSubagentTranscript === undefined || subagent.transcriptFollowerStarted) {
      return;
    }
    subagent.transcriptFollowerStarted = true;
    const stop = yield* Deferred.make<void>();
    subagent.transcriptFollowerStop = stop;
    yield* Effect.gen(function* () {
      let idleStep = 0;
      while (acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) {
        const changed = yield* drain(subagent, false);
        idleStep = changed ? 0 : Math.min(idleStep + 1, ACP_SUBAGENT_TRANSCRIPT_POLL_MS.length - 1);
        if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) break;
        const pollMs = ACP_SUBAGENT_TRANSCRIPT_POLL_MS[idleStep] ?? 5_000;
        const stopped = yield* Deferred.await(stop).pipe(
          Effect.as(true),
          Effect.timeoutOrElse({
            duration: Duration.millis(pollMs),
            orElse: () => Effect.succeed(false),
          }),
        );
        if (stopped) break;
      }
    }).pipe(Effect.ignoreCause, Effect.forkIn(deps.sessionScope));
  });

  const hasTrailingDrainForNativeThread = (nativeThreadId: string | null | undefined) =>
    [...trailingTranscriptDrains].some((subagent) => subagent.rootSessionId === nativeThreadId);

  return {
    drain,
    stopFollower,
    startTrailingDrain,
    startFollower,
    hasTrailingDrainForNativeThread,
  };
}
