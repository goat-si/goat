import type { OrchestrationV2UserInputQuestion, ProviderApprovalDecision } from "@goat/contracts";

import * as Predicate from "effect/Predicate";
import {
  piRecordField as recordField,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

export function piQuestion(
  questionId: string,
  method: "select" | "input" | "editor",
  title: string,
  event: PiRpcRecord,
): OrchestrationV2UserInputQuestion {
  const options =
    method === "select" && Array.isArray(event["options"])
      ? event["options"]
          .filter((option): option is string => typeof option === "string")
          .map((option) => ({
            label: option || "Empty value",
            description: option || "Empty value",
            value: option,
          }))
      : method === "editor"
        ? []
        : [
            {
              label: "Submit empty value",
              description: "Send an empty string to the extension.",
              value: "",
            },
          ];
  // Pi's select and editor dialogs carry only a title, so show it once, as the question.
  // Extensions may send a blank placeholder, which is not a valid question.
  const detail = [recordString(event, "message"), recordString(event, "placeholder")].find(
    (text) => text !== undefined && text.trim().length > 0,
  );
  const questionTitle = title.trim() ? title : "Question";
  return {
    id: questionId,
    header: detail === undefined ? "Question" : questionTitle,
    question: detail ?? questionTitle,
    ...(method === "editor" ? { initialAnswer: recordString(event, "prefill") ?? "" } : {}),
    options,
  };
}

export function piUiResponse(
  pending: {
    readonly method: "select" | "confirm" | "input" | "editor";
    readonly questionId: string;
  },
  decision: ProviderApprovalDecision | undefined,
  answers: Record<string, unknown> | undefined,
): PiRpcRecord {
  if (pending.method === "confirm") {
    if (decision === "accept" || decision === "acceptForSession") return { confirmed: true };
    if (decision === "decline") return { confirmed: false };
    return { cancelled: true };
  }
  const answer = answers?.[pending.questionId];
  // RPC distinguishes empty dialog values from cancellation (undefined).
  if (typeof answer === "string") return { value: answer };
  return { cancelled: true };
}

export interface PiCustomAnswerRoute {
  readonly lines: ReadonlyArray<unknown>;
  readonly sentinel: string;
  readonly followUpTitlePrefix: string;
}

/** The extension normalizes line terminators in each question field before building the dialog. */
const rpivField = (input: unknown, key: string) =>
  recordString(input, key)?.replace(/\r\n/g, "\n").replace(/\r/g, "");

const rpivOptionLine = (option: unknown, index: number) =>
  // oxlint-disable-next-line goat/no-em-dash-copy -- Matches the extension protocol.
  `${index + 1}. ${rpivField(option, "label")} \u2014 ${rpivField(option, "description")}`;

/** The extension folds option previews into the select title, the only place clients show them. */
const rpivPreviewBlock = (options: ReadonlyArray<unknown>) => {
  const blocks = options.flatMap((option, index) => {
    const preview = rpivField(option, "preview");
    return preview
      ? [`--- ${index + 1}. ${rpivField(option, "label")} preview ---\n${preview.slice(0, 600)}`]
      : [];
  });
  return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
};

/** Mirrors the extension's `prepareQuestionArguments`: some models JSON-encode nested args. */
const rpivDecoded = (value: unknown, isShape: (parsed: unknown) => boolean) => {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return isShape(parsed) ? parsed : value;
  } catch {
    return value;
  }
};

/**
 * @juicesharp/rpiv-ask-user-question asks a single-select question over RPC as a select of
 * "N. label \u2014 description" lines plus a trailing "Type something." entry. Rebuild the question
 * from the tool call's arguments; each option answers with its original line, which the extension
 * maps back to that option.
 */
export function piAskUserSingleSelectQuestion(
  questionId: string,
  title: string,
  event: PiRpcRecord,
  toolArgs: ReadonlyMap<
    string,
    { readonly args: unknown; readonly name: string | undefined; readonly active: boolean }
  >,
):
  | { question: OrchestrationV2UserInputQuestion; customAnswerRoute: PiCustomAnswerRoute }
  | undefined {
  const lines = event["options"];
  if (!Array.isArray(lines) || lines.length < 2) return undefined;
  const sentinel = lines.at(-1);
  if (sentinel !== `${lines.length}. Type something.`) return undefined;
  for (const call of toolArgs.values()) {
    if (!call.active || call.name !== "ask_user_question") continue;
    const args = call.args;
    const questions = rpivDecoded(recordField(args, "questions"), Array.isArray);
    if (!Array.isArray(questions)) continue;
    for (const entry of questions) {
      const question = rpivDecoded(entry, Predicate.isObject);
      const text = rpivField(question, "question");
      const header = rpivField(question, "header");
      if (
        recordField(question, "multiSelect") === true ||
        recordField(question, "allowCustomAnswer") === false ||
        recordField(question, "custom") === false ||
        !text?.trim()
      )
        continue;
      const prefix = header ? `[${header}] ` : "";
      if (!title.startsWith(`${prefix}${text}`)) continue;
      const encodedOptions = rpivDecoded(recordField(question, "options"), Array.isArray);
      if (!Array.isArray(encodedOptions) || encodedOptions.length !== lines.length - 1) continue;
      const options = encodedOptions.map((option) => rpivDecoded(option, Predicate.isObject));
      const body = `${text}${rpivPreviewBlock(options)}`;
      if (title !== `${prefix}${body}`) continue;
      if (!options.every((option, index) => lines[index] === rpivOptionLine(option, index))) {
        continue;
      }
      return {
        question: {
          id: questionId,
          header: header?.trim() || "Question",
          question: body.trim(),
          options: options.map((option, index) => {
            const label = rpivField(option, "label")?.trim() || `Option ${index + 1}`;
            return {
              label,
              description: rpivField(option, "description")?.trim() || label,
              value: rpivOptionLine(option, index),
            };
          }),
        },
        // The follow-up repeats the option lines; only its trailing instruction is localized.
        customAnswerRoute: {
          lines,
          sentinel,
          followUpTitlePrefix: `${prefix}${text}\n\n${lines.slice(0, -1).join("\n")}\n\n`,
        },
      };
    }
  }
  return undefined;
}

let pendingCustomAnswerTotal = 0;

export class PiCustomAnswers {
  private readonly pending = new Map<string, string[]>();
  private total = 0;
  clear() {
    pendingCustomAnswerTotal -= this.total;
    this.pending.clear();
    this.total = 0;
  }
  take(method: string, event: PiRpcRecord): string | undefined {
    const title =
      method === "input" && event["placeholder"] === "" ? (recordString(event, "title") ?? "") : "";
    const prefix = [...this.pending.keys()]
      .filter((key) => title.startsWith(key))
      .reduce<string | undefined>((a, b) => (b.length > (a?.length ?? -1) ? b : a), undefined);
    if (prefix === undefined) return undefined;
    const values = this.pending.get(prefix) ?? [];
    const answer = values.shift();
    if (answer !== undefined) {
      this.total--;
      pendingCustomAnswerTotal--;
    }
    if (values.length === 0) this.pending.delete(prefix);
    return answer;
  }
  route(route: PiCustomAnswerRoute | undefined, response: PiRpcRecord): PiRpcRecord | null {
    const value = response["value"];
    if (
      route === undefined ||
      typeof value !== "string" ||
      !value.trim() ||
      route.lines.includes(value)
    )
      return response;
    const queued = this.pending.get(route.followUpTitlePrefix) ?? [];
    if (
      queued.length >= 8 ||
      this.total >= 64 ||
      pendingCustomAnswerTotal >= 256 ||
      value.length > 16384
    )
      return null;
    this.total++;
    pendingCustomAnswerTotal++;
    this.pending.set(route.followUpTitlePrefix, [
      ...(this.pending.get(route.followUpTitlePrefix) ?? []),
      value,
    ]);
    return { value: route.sentinel };
  }
}

export function piToolCallArguments(
  calls: Map<
    string,
    { readonly args: unknown; readonly name: string | undefined; active: boolean }
  >,
  phase: "start" | "update" | "end",
  id: string,
  name: string | undefined,
  event: PiRpcRecord,
): unknown {
  if (phase === "start") calls.set(id, { args: event["args"], name, active: true });
  const call = calls.get(id);
  const args = event["args"] ?? call?.args;
  if (phase === "end" && call !== undefined) call.active = false;
  return args;
}
