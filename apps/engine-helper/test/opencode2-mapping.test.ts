import test from "node:test";
import assert from "node:assert/strict";
import type { FormInfo, PermissionRequest } from "@opencode/client";
import { formAnswer, formQuestions, formReply } from "../src/engines/opencode2/forms.ts";
import { malformedModel, modelRef, modelVariantCapabilities, openCodeVariant, sameModel } from "../src/engines/opencode2/modelRef.ts";
import { cuaMcpServerName, deniesSubagents, goatMcpServerName, permissionKind, permissionReply, sameRules, sessionRules, type Rule } from "../src/engines/opencode2/permissions.ts";

const selection = { instanceId: "opencode", model: " provider/model/sub ", options: [{ id: "variant", value: "high" }] };
const nativeForm: FormInfo = { id: "form-1", sessionID: "child-1", title: "Questions", fields: [
  { key: "choice", type: "string", title: " Choose ", description: "", required: true, options: [{ value: "native-value", label: " Display ", description: " Details " }] },
  { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], minItems: 1, custom: true },
  { key: "free", type: "string", title: " ", options: [] },
] };
const request: PermissionRequest = { id: "p1", sessionID: "child-1", action: "shell", resources: ["src/*"], save: ["src/*", "tests/*"] };

test("model references honor default, unknown and known catalogs and variant equality", () => {
  assert.deepEqual(modelRef(selection, undefined), { providerID: "provider", id: "model/sub", variant: "high" });
  assert.deepEqual(modelRef(selection, new Set(["high", "low"])), { providerID: "provider", id: "model/sub", variant: "high" });
  assert.deepEqual(modelRef(selection, new Set(["low"])), { providerID: "provider", id: "model/sub" });
  assert.deepEqual(modelRef({ ...selection, options: [{ id: "variant", value: "goat:default" }] }, undefined), { providerID: "provider", id: "model/sub" });
  assert.equal(openCodeVariant({ ...selection, options: [{ id: "variant", value: true }] }), undefined);
  assert.equal(modelRef({ ...selection, model: "provider" }, undefined), undefined);
  assert.equal(modelRef({ ...selection, model: "/model" }, undefined), undefined);
  assert.equal(modelRef({ ...selection, model: "provider/" }, undefined), undefined);
  assert.match(malformedModel("invalid"), /provider\/model/);
  const ref = { providerID: "provider", id: "model" };
  assert.equal(sameModel(ref, { ...ref, variant: "default" }), true);
  assert.equal(sameModel(ref, { ...ref, variant: "high" }), false);
  assert.equal(sameModel(ref, { ...ref, providerID: "other" }), false);
  assert.equal(sameModel(ref, { ...ref, id: "other" }), false);
  assert.equal(sameModel(ref, undefined), false);
});

test("catalog choices retain v1 default and label inference", () => {
  assert.equal(modelVariantCapabilities("other", []), null);
  const descriptor = modelVariantCapabilities("other", ["low", "xhigh"])!.optionDescriptors![0]!;
  assert.equal(descriptor.type, "select");
  if (descriptor.type !== "select") throw new Error("expected select");
  assert.deepEqual(descriptor.options.map((o) => [o.id, o.label]), [["goat:default", "Default"], ["low", "Low"], ["xhigh", "Extra High"]]);
  assert.equal(descriptor.currentValue, "goat:default");
  const inferred = modelVariantCapabilities("openai", ["high", "medium"])!.optionDescriptors![0]!;
  assert.equal(inferred.currentValue, "medium");
  assert.equal(modelVariantCapabilities("anthropic", ["low", "high"])!.optionDescriptors![0]!.currentValue, "high");
  assert.equal(modelVariantCapabilities("other", ["only"])!.optionDescriptors![0]!.currentValue, "only");
});

test("string and multiselect form questions preserve option identity and answers roundtrip", () => {
  const result = formQuestions(nativeForm);
  assert.ok("questions" in result);
  assert.deepEqual(result.questions, [
    { id: "choice", header: "Choose", question: "Choose", options: [{ value: "native-value", label: "Display", description: "Details" }], multiSelect: false, allowCustomAnswer: false, required: true },
    { id: "tags", header: "Question 2", question: "Question 2", options: [{ value: "a", label: "A", description: "A" }, { value: "b", label: "B", description: "B" }], multiSelect: true, allowCustomAnswer: true, required: true },
    { id: "free", header: "Question 3", question: "Question 3", options: [], multiSelect: false, allowCustomAnswer: true },
  ]);
  assert.deepEqual(formAnswer(nativeForm, { choice: "native-value", tags: ["a", "b"], free: "own answer" }), { choice: "native-value", tags: ["a", "b"], free: "own answer" });
  assert.deepEqual(formAnswer(nativeForm, { tags: [], choice: ["a", "b"], free: " " }), { choice: "a, b", tags: [] });
  assert.deepEqual(formReply(nativeForm, { outcome: "answered", answers: { choice: "native-value", tags: ["b"] } }), { type: "reply", sessionID: "child-1", formID: "form-1", answer: { choice: "native-value", tags: ["b"] } });
  assert.deepEqual(formReply(nativeForm, { outcome: "accept", text: "native-value" }), { type: "reply", sessionID: "child-1", formID: "form-1", answer: { choice: "native-value" } });
  for (const outcome of ["cancel", "decline"] as const) assert.deepEqual(formReply(nativeForm, { outcome }), { type: "cancel", sessionID: "child-1", formID: "form-1" });
  assert.throws(() => formReply(nativeForm, { outcome: "answered" }), /requires answers/);
  assert.throws(() => formReply({ ...nativeForm, fields: [] } as unknown as FormInfo, { outcome: "answered", text: "x" }), /requires answers/);
  assert.throws(() => formReply(nativeForm, { outcome: "resend", answers: {} }), /requires an answer/);
});

test("unsupported form field types and conditional or hidden fields fail visibly", () => {
  const fields: FormInfo["fields"][number][] = [
    { key: "x", type: "external", url: "https://example.invalid" },
    { key: "x", type: "number" }, { key: "x", type: "integer" }, { key: "x", type: "boolean" },
    { key: "x", type: "string", hidden: true },
    { key: "x", type: "multiselect", options: [], when: [{ key: "other", op: "eq", value: true }] },
  ];
  for (const field of fields) {
    const form: FormInfo = { ...nativeForm, fields: [field] };
    assert.ok("unsupported" in formQuestions(form), field.type);
    assert.throws(() => formReply(form, { outcome: "answered", answers: { x: "x" } }), { code: "unsupported" });
  }
});

// Pinned v2/sessionRules.ts says last matching action/resource rule wins.
function effect(rules: ReadonlyArray<Rule>, action: string, resource = "*") {
  const matches = (pattern: string, value: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(value);
  return rules.filter((r) => matches(r.action, action) && matches(r.resource, resource)).at(-1)?.effect;
}

test("rule order confines other threads and CUA, then denies subagents last", () => {
  const a = goatMcpServerName("thread-a"), b = goatMcpServerName("thread-b");
  const cua = cuaMcpServerName("thread-a");
  assert.notEqual(a, b);
  assert.notEqual(goatMcpServerName("a/b"), goatMcpServerName("a_b"));
  assert.match(goatMcpServerName("x".repeat(57)), /^goat-[0-9a-f]{16}$/);
  const rules = sessionRules({ runtimeMode: "full-access", interactionMode: "plan" }, [{ action: "edit", resource: "plan/*", effect: "allow" }], [{ action: "goat-*", resource: "*", effect: "allow" }, { action: "subagent", resource: "*", effect: "allow" }], { goat: a, cua }, true);
  assert.equal(effect(rules, `${a}_tool`), "allow");
  assert.equal(effect(rules, `${b}_tool`), "deny");
  assert.equal(effect(rules, "t3-code-old_tool"), "deny");
  assert.equal(effect(rules, `${cua}_tool`), "allow");
  assert.equal(effect(rules, `${cuaMcpServerName("thread-b")}_tool`), "deny");
  assert.equal(effect(rules, "edit", "other"), "deny");
  assert.equal(effect(rules, "edit", "plan/today"), "allow");
  assert.equal(effect(rules, "subagent"), "deny");
  assert.equal(deniesSubagents(rules), true);
  assert.equal(sameRules(rules, [...rules]), true);
  assert.equal(sameRules(rules, [...rules].reverse()), false);
  assert.equal(sameRules(undefined, []), false);
});

test("runtime modes and native approval decisions preserve per-session grants", () => {
  for (const mode of ["approval-required", "auto", "auto-accept-edits"] as const) {
    const rules = sessionRules({ runtimeMode: mode }, [], [], null, false);
    assert.equal(effect(rules, "shell"), "ask");
    assert.equal(effect(rules, "external_directory"), "ask");
    assert.equal(effect(rules, "edit"), mode === "auto-accept-edits" ? "allow" : "ask");
    assert.equal(effect(rules, "cua-driver-other_tool"), "deny");
  }
  assert.deepEqual(permissionReply(request, "accept", []).reply, { sessionID: "child-1", requestID: "p1", decision: "once" });
  const initial: Rule[] = [{ action: "shell", resource: "src/*", effect: "allow" }];
  const saved = permissionReply(request, "acceptForSession", initial);
  assert.deepEqual(saved.grants, [...initial, { action: "shell", resource: "tests/*", effect: "allow" }]);
  assert.equal(initial.length, 1);
  assert.deepEqual(permissionReply(request, "acceptAlways", []).grants, [{ action: "shell", resource: "src/*", effect: "allow" }, { action: "shell", resource: "tests/*", effect: "allow" }]);
  assert.deepEqual(permissionReply(request, "decline", []).reply, { sessionID: "child-1", requestID: "p1", decision: "reject", message: "The user declined this request." });
  assert.equal(permissionReply(request, "cancel", []).reply.decision, "reject");
  assert.equal(permissionReply({ ...request, action: "subagent" }, "accept", []).reply.decision, "once");
  assert.throws(() => permissionReply(request, "answered", []), { code: "bad_request" });
});

test("approval kinds follow the native action and tool name", () => {
  assert.equal(permissionKind("external_directory"), "file-read");
  assert.equal(permissionKind("anything", "apply_patch"), "file-change");
  assert.equal(permissionKind("anything", "code_search"), "file-read");
  assert.equal(permissionKind("shell"), "command");
});
