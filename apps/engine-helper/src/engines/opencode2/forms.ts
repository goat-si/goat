import type { UserInputQuestion } from "@goat2/contracts-rs";
import type { FormInfo, SessionFormReplyInput } from "@opencode/client";
import { HelperError, type RequestAnswer } from "../../protocol.ts";

// Adapted from v2/adapterUtilities.ts:19-70 at 916b5ccc1b.
const text = (value: string | undefined, fallback: string) => value?.trim() || fallback;

export function formQuestions(form: FormInfo): { questions: UserInputQuestion[] } | { unsupported: string } {
  const questions: UserInputQuestion[] = [];
  for (const [index, field] of form.fields.entries()) {
    if (field.type === "external") return { unsupported: "a link to open" };
    if (field.type !== "string" && field.type !== "multiselect") return { unsupported: `a ${field.type} value` };
    if (field.hidden === true) return { unsupported: "a hidden field" };
    if ((field.when?.length ?? 0) > 0) return { unsupported: "a field that depends on another" };
    const header = text(field.title, `Question ${index + 1}`);
    const options = (field.options ?? []).map((option) => {
      const label = text(option.label, text(option.value, "Option"));
      return { label, description: text(option.description, label), value: option.value };
    });
    questions.push({ id: field.key, header, question: text(field.description, header), options,
      multiSelect: field.type === "multiselect", allowCustomAnswer: field.custom === true || options.length === 0,
      ...(field.required === true || (field.type === "multiselect" && (field.minItems ?? 0) > 0) ? { required: true } : {}) });
  }
  return { questions };
}

export function formAnswer(form: FormInfo, answers: Readonly<Record<string, unknown>>): SessionFormReplyInput["answer"] {
  const mapped = formQuestions(form);
  if ("unsupported" in mapped) throw new HelperError("unsupported", `OpenCode form contains ${mapped.unsupported}`);
  const entries: Array<[string, string | string[]]> = [];
  for (const field of form.fields) {
    const raw = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    const values = (Array.isArray(raw) ? raw : [raw]).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (field.type === "multiselect" && (Array.isArray(raw) || values.length > 0)) entries.push([field.key, values]);
    else if (values.length > 0) entries.push([field.key, values.join(", ")]);
  }
  return Object.fromEntries(entries);
}

export function formReply(form: FormInfo, response: RequestAnswer):
  | { type: "cancel"; sessionID: string; formID: string }
  | { type: "reply"; sessionID: string; formID: string; answer: SessionFormReplyInput["answer"] } {
  const target = { sessionID: form.sessionID, formID: form.id };
  if (response.outcome === "cancel" || response.outcome === "decline") return { type: "cancel", ...target };
  if (!["answered", "accept"].includes(response.outcome)) throw new HelperError("bad_request", "OpenCode form requires an answer or cancellation");
  const first = form.fields[0];
  const answers = response.answers ?? (response.text != null && first ? { [first.key]: response.text } : undefined);
  if (answers === undefined) throw new HelperError("bad_request", "OpenCode form requires answers");
  return { type: "reply", ...target, answer: formAnswer(form, answers) };
}
