import { SKILL_MENTION_PATTERN } from "@goat/shared/composerInlineTokens";
import type { OpenCodeEvent } from "@opencode/client/effect";
import type {
  OrchestrationV2UserInputQuestion,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderApprovalDecision,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { OPENCODE_PROVIDER } from "../adapter.ts";
import type { Rule } from "./sessionRules.ts";
type NativeForm = Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"];

const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

export const formQuestions = (
  form: NativeForm,
):
  | { readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion> }
  | { readonly unsupported: string } => {
  const questions: Array<OrchestrationV2UserInputQuestion> = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") {
      return { unsupported: `a ${field.type} value` };
    }
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label), value: option.value };
    });
    questions.push({
      id: field.key,
      header,
      question: text(field.description, header),
      options,
      multiSelect: field.type === "multiselect",
      allowCustomAnswer: field.custom === true || options.length === 0,
    });
  }
  return { questions };
};

export const formAnswer = (form: NativeForm, answers: Readonly<Record<string, unknown>>) => {
  const answer: Record<string, string | ReadonlyArray<string>> = {};
  for (const field of form.fields) {
    const raw = answers[field.key];
    const values = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (values.length > 0) {
      answer[field.key] = field.type === "multiselect" ? values : values.join(", ");
    }
  }
  return answer;
};

export const approves = (decision: ProviderApprovalDecision) =>
  decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";

export const permissionGone = {
  PermissionNotFoundError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};
export const formGone = {
  FormNotFoundError: () => Effect.void,
  FormAlreadySettledError: () => Effect.void,
  SessionNotFoundError: () => Effect.void,
};

export const agentPaths = (rules: ReadonlyArray<Rule>) =>
  rules.filter(
    (entry) =>
      entry.effect === "allow" &&
      entry.resource !== "*" &&
      (entry.action === "edit" || entry.action === "external_directory"),
  );

export const ref = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: OPENCODE_PROVIDER,
  nativeId,
  strength,
});

export const sessionIdOf = (providerThread: OrchestrationV2ProviderThread) => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  return nativeId === undefined || nativeId === null
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: OPENCODE_PROVIDER,
          detail: `Provider thread ${providerThread.id} has no OpenCode session`,
        }),
      )
    : Effect.succeed(nativeId);
};

export const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  content.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");

export const stringField = (record: Readonly<Record<string, unknown>> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

export const subagentOutput = (text: string) =>
  /^<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>$/.exec(text.trim())?.[1] ?? text;

export const isContinuation = (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";

export const wakeTurnId = (sessionId: string, attemptId: string) =>
  `${sessionId}:wake:${attemptId}`;
const isWakeTurn = (turn: OrchestrationV2ProviderTurn) =>
  turn.nativeTurnRef?.nativeId?.includes(":wake:") === true;

// OpenCode's claude-agent reports a spent Claude plan as provider.unknown with Claude's own text.
export const claudeUsageLimit = (message: string | undefined) =>
  message !== undefined && /^You've hit your [^\n·]*\blimit\b/.test(message)
    ? { resetAt: /\bResets at (\d{4}-\d\d-\d\dT[\d:.]+Z)\.?\s*$/.exec(message)?.[1] ?? null }
    : undefined;

export const promptOf = (turn: OrchestrationV2ProviderTurn) => {
  const nativeId = turn.nativeTurnRef?.nativeId;
  return nativeId?.startsWith("msg_") === true ? nativeId : undefined;
};

export const boundaryAfter = (
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThreadId: OrchestrationV2ProviderThread["id"],
  kept: OrchestrationV2ProviderTurn | undefined,
  prompts: ReadonlySet<string>,
) => {
  const later = turns
    .filter(
      (turn) =>
        turn.providerThreadId === providerThreadId &&
        (kept === undefined || turn.ordinal > kept.ordinal),
    )
    .toSorted((left, right) => left.ordinal - right.ordinal);
  if (later.some((turn) => promptOf(turn) === undefined && !isWakeTurn(turn))) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver: OPENCODE_PROVIDER,
        detail:
          "This OpenCode conversation has turns from an earlier GOAT version, so it can't be cut there.",
      }),
    );
  }
  return Effect.succeed(
    later.map(promptOf).find((messageId) => messageId !== undefined && prompts.has(messageId)) ??
      null,
  );
};

export const agentFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
  input.runtimePolicy.interactionMode === "plan" ? "plan" : "build";

export const skillMentions = (text: string) => [
  ...new Set([...text.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => match[2] ?? [])),
];
