import type { ProviderApprovalDecision, ProviderApprovalOption } from "@goat/contracts";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

const NullableMcpElicitationString = Schema.NullOr(Schema.String);
const McpElicitationMetadata = Schema.Struct({
  app: Schema.optionalKey(NullableMcpElicitationString),
  app_name: Schema.optionalKey(NullableMcpElicitationString),
  appName: Schema.optionalKey(NullableMcpElicitationString),
  connector_name: Schema.optionalKey(NullableMcpElicitationString),
  connectorName: Schema.optionalKey(NullableMcpElicitationString),
  allowPersistentApproval: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  target: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
  tool_params: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        app_name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
});
const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationMetadata = Schema.is(McpElicitationMetadata);
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationPersistenceDecision = Extract<
  ProviderApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

// Claude hands over the same MCP request with its own envelope; these are the
// only fields the response is built from.
type McpElicitationResponseInput = {
  readonly mode: string;
  readonly requestedSchema?: unknown;
};

function mcpElicitationFormFields(payload: McpElicitationResponseInput) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

export function canAutoApproveMcpElicitation(payload: McpElicitationResponseInput): boolean {
  return autoApproveMcpElicitation(payload).action === "accept";
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

function scopeRank(value: string): number | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (/^(?:once|once_only|one_time|this_time|allow_once|approve_once)$/.test(normalized)) return 0;
  if (/^(?:session|this_session|allow_session|allow_for_session)$/.test(normalized)) return 1;
  if (/^(?:always|permanent|forever|persistent|allow_always)$/.test(normalized)) return 2;
  return undefined;
}

export function autoApproveMcpElicitation(
  payload: McpElicitationResponseInput,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (payload.mode !== "form") return { action: "cancel" };
  const form = mcpElicitationFormFields(payload);
  if (form === undefined) return { action: "cancel" };
  if ((form.required?.length ?? 0) > 128) return { action: "cancel" };
  const content: Record<string, Schema.Json> = {};
  const fields = form.properties ?? {};
  let count = 0;
  for (const key in fields) {
    if (!Object.hasOwn(fields, key)) continue;
    if (++count > 128) return { action: "cancel" };
    const field = fields[key];
    if (field === undefined) return { action: "cancel" };
    if ((field.oneOf?.length ?? field.enum?.length ?? 0) > 128) return { action: "cancel" };
    const required = form.required?.includes(key) === true;
    const options = mcpElicitationFieldOptions(field);
    const ranks = options.map((option) => scopeRank(option.value));
    const scopeChoice = options.length > 0 && ranks.every((rank) => rank !== undefined);
    const persistence =
      field.type === "boolean" &&
      /(?:remember|persist|always|permanent)/i.test(
        `${key} ${field.title ?? ""} ${field.description ?? ""}`,
      );
    if (field.default !== undefined) {
      if (persistence && field.default !== false) return { action: "cancel" };
      if (
        typeof field.default === "string" &&
        scopeRank(field.default) === 2 &&
        /(?:scope|persist|remember|approval|access|allow)/i.test(
          `${key} ${field.title ?? ""} ${field.description ?? ""}`,
        )
      )
        return { action: "cancel" };
      if (scopeChoice) {
        const defaultRank =
          typeof field.default === "string" ? scopeRank(field.default) : undefined;
        if (
          defaultRank === undefined ||
          defaultRank === 2 ||
          defaultRank !== Math.min(...ranks.map((rank) => rank ?? 2))
        )
          return { action: "cancel" };
      }
      content[key] = field.default;
    } else if (required && persistence) {
      content[key] = false;
    } else if (required && scopeChoice) {
      const best = Math.min(...ranks.map((rank) => rank ?? 2));
      const matches = options.filter((_, index) => ranks[index] === best);
      if (best === 2 || matches.length !== 1 || matches[0] === undefined)
        return { action: "cancel" };
      content[key] = matches[0].value;
    } else if (required) return { action: "cancel" };
  }
  if (form.required?.some((key) => !Object.hasOwn(content, key))) return { action: "cancel" };
  return { action: "accept", content };
}

function isMcpElicitationPersistenceField(
  key: string,
  field: typeof McpElicitationFormField.Type,
): boolean {
  return (
    mcpElicitationPersistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    mcpElicitationPersistenceDecision(field.title ?? "") !== null ||
    mcpElicitationPersistenceDecision(field.description ?? "") !== null
  );
}

export function describeMcpElicitation(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): { readonly appName: string; readonly options: ReadonlyArray<ProviderApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName =
    metadata?.app_name ??
    metadata?.appName ??
    metadata?.app ??
    metadata?.target?.app ??
    metadata?.target?.name ??
    metadata?.tool_params?.app_name ??
    metadata?.tool_params?.app ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    metadata?.connector_name ??
    metadata?.connectorName ??
    payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      persistenceOptions.set("acceptAlways", field.title ?? "");
    }
  }

  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      ...(persistenceOptions.has("acceptAlways") &&
      toMcpElicitationResponse(payload, "acceptAlways").action === "accept"
        ? [
            {
              decision: "acceptAlways" as const,
              label: persistenceOptions.get("acceptAlways") || "Always allow",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

export function toMcpElicitationResponse(
  payload: McpElicitationResponseInput,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i.test(
            option.value.trim(),
          ) && mcpElicitationPersistenceDecision(option.value) === null,
    );
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}
