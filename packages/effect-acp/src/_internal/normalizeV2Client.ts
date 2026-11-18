import * as Option from "effect/Option";
import { decodeNoticeUpdate } from "./normalizeV1SessionUpdate.ts";
import * as AcpSchema from "../compat.ts";
import type * as AcpSchemaV1 from "../_generated/schema-v1.gen.ts";
import type * as AcpSchemaV2 from "../_generated/schema.gen.ts";
import type * as AcpProtocol from "../protocol.ts";
import * as Predicate from "effect/Predicate";

function normalizeContentBlock(content: AcpSchemaV2.ContentBlock): AcpSchema.ContentBlock {
  switch (content.type) {
    case "text":
    case "image":
    case "audio":
    case "resource_link":
    case "resource":
      return content as AcpSchema.ContentBlock;
    default:
      return { type: "_t3_unknown", originalType: content.type, raw: content };
  }
}

function normalizeToolCallContent(content: AcpSchemaV2.ToolCallContent): AcpSchema.ToolCallContent {
  if (content.type === "content") {
    const known = content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "content" }>;
    return { ...known, content: normalizeContentBlock(known.content) };
  }
  if (content.type === "terminal") {
    return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "terminal" }>;
  }
  if (content.type !== "diff") {
    return { type: "_t3_unknown", originalType: content.type, raw: content };
  }

  return content as Extract<AcpSchemaV2.ToolCallContent, { readonly type: "diff" }>;
}

function normalizeToolCallUpdate(update: AcpSchemaV2.ToolCallUpdate): AcpSchema.ToolCallUpdate {
  return {
    toolCallId: update.toolCallId,
    ...(update.name === undefined ? {} : { name: update.name }),
    ...(update.title === undefined ? {} : { title: update.title }),
    ...(update.kind === undefined ? {} : { kind: update.kind }),
    ...(update.status === undefined ? {} : { status: update.status }),
    ...(update.content === undefined
      ? {}
      : {
          content: update.content === null ? null : update.content.map(normalizeToolCallContent),
        }),
    ...(update.locations === undefined ? {} : { locations: update.locations }),
    ...(update.rawInput === undefined ? {} : { rawInput: update.rawInput }),
    ...(update.rawOutput === undefined ? {} : { rawOutput: update.rawOutput }),
    ...(update._meta === undefined ? {} : { _meta: update._meta }),
  };
}

function normalizeConfigOption(
  option: AcpSchemaV2.SessionConfigOption,
): AcpSchema.SessionConfigOption | undefined {
  if (option.type === "boolean") {
    const known = option as Extract<AcpSchemaV2.SessionConfigOption, { readonly type: "boolean" }>;
    return {
      type: "boolean",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  if (option.type === "select") {
    const known = option as Extract<AcpSchemaV2.SessionConfigOption, { readonly type: "select" }>;
    return {
      type: "select",
      id: known.configId,
      name: known.name,
      currentValue: known.currentValue,
      options: known.options,
      ...(known.description === undefined ? {} : { description: known.description }),
      ...(known.category === undefined ? {} : { category: known.category }),
      ...(known._meta === undefined ? {} : { _meta: known._meta }),
    };
  }
  return undefined;
}

export function normalizeConfigOptions(
  options: ReadonlyArray<AcpSchemaV2.SessionConfigOption> | undefined,
): ReadonlyArray<AcpSchema.SessionConfigOption> | undefined {
  return options?.flatMap((option) => {
    const normalized = normalizeConfigOption(option);
    return normalized === undefined ? [] : [normalized];
  });
}

export function normalizeSessionUpdate(
  notification: AcpSchemaV2.UpdateSessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  const base = {
    sessionId: notification.sessionId,
    ...(notification._meta === undefined ? {} : { _meta: notification._meta }),
  };

  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        {
          readonly sessionUpdate:
            | "user_message_chunk"
            | "agent_message_chunk"
            | "agent_thought_chunk";
        }
      >;
      const content = normalizeContentBlock(known.content);
      return { ...base, update: { ...known, content } };
    }
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "user_message" | "agent_message" | "agent_thought" }
      >;
      const content = known.content;
      return {
        ...base,
        update: {
          ...known,
          ...(content === undefined
            ? {}
            : {
                content:
                  content === null
                    ? null
                    : (content as ReadonlyArray<AcpSchemaV2.ContentBlock>).map(
                        normalizeContentBlock,
                      ),
              }),
        },
      } as AcpSchema.SessionNotification;
    }
    case "tool_call_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "tool_call_update" }
      >;
      return {
        ...base,
        update: { sessionUpdate: "tool_call_update", ...normalizeToolCallUpdate(known) },
      };
    }
    case "tool_call_content_chunk": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "tool_call_content_chunk" }
      >;
      return {
        ...base,
        update: {
          sessionUpdate: "tool_call_content_chunk",
          toolCallId: known.toolCallId,
          content: normalizeToolCallContent(known.content),
          ...(known._meta === undefined ? {} : { _meta: known._meta }),
        },
      };
    }
    case "config_option_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "config_option_update" }
      >;
      return {
        ...base,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: known.configOptions.flatMap((option) => {
            const normalized = normalizeConfigOption(option);
            return normalized === undefined ? [] : [normalized];
          }),
          ...(known._meta === undefined ? {} : { _meta: known._meta }),
        },
      };
    }
    case "state_update":
    case "terminal_update":
    case "terminal_output_chunk":
    case "plan_update":
    case "plan_removed":
    case "session_info_update":
    case "usage_update":
    case "compaction_update":
    case "compaction_summary_chunk":
      return { ...base, update } as AcpSchema.SessionNotification;
    case "available_commands_update": {
      const known = update as Extract<
        AcpSchemaV2.SessionUpdate,
        { readonly sessionUpdate: "available_commands_update" }
      >;
      return {
        ...base,
        update: {
          ...known,
          availableCommands: known.availableCommands.map((command) => ({
            ...command,
            ...(command.input?.type === "text"
              ? {
                  input: command.input as Extract<
                    AcpSchemaV2.AvailableCommandInput,
                    { readonly type: "text" }
                  >,
                }
              : { input: null }),
          })),
        },
      };
    }
    default: {
      const notice = decodeNoticeUpdate(update);
      if (Option.isSome(notice)) return { ...base, update: notice.value };
      return {
        ...base,
        update: {
          sessionUpdate: "_t3_unknown",
          originalSessionUpdate: update.sessionUpdate,
          raw: update,
        },
      };
    }
  }
}

export function toV2McpServer(server: AcpSchema.McpServer): AcpSchemaV2.McpServer {
  if ("type" in server) return server;
  return {
    type: "stdio",
    name: server.name,
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server._meta === undefined ? {} : { _meta: server._meta }),
  };
}

export function toV2ResumeRequest(
  request: AcpSchema.ResumeSessionRequest,
  replayFrom?: AcpSchemaV2.ReplayFrom,
): AcpSchemaV2.ResumeSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
    ...(replayFrom === undefined ? {} : { replayFrom }),
  };
}

export function toV2ForkRequest(
  request: AcpSchema.ForkSessionRequest,
): AcpSchemaV2.ForkSessionRequest {
  const { mcpServers, ...rest } = request;
  return {
    ...rest,
    ...(mcpServers === undefined ? {} : { mcpServers: mcpServers.map(toV2McpServer) }),
  };
}

export function normalizeInitializeResponse(
  response: AcpSchemaV2.InitializeResponse,
): AcpSchema.InitializeResponse {
  const session = response.capabilities?.session;
  const prompt = session?.prompt;
  const mcp = session?.mcp;
  return {
    protocolVersion: response.protocolVersion,
    agentInfo: response.info,
    agentCapabilities: {
      loadSession: session !== undefined && session !== null,
      promptCapabilities: {
        image: prompt?.image != null,
        audio: prompt?.audio != null,
        embeddedContext: prompt?.embeddedContext != null,
      },
      mcpCapabilities: {
        stdio: mcp?.stdio != null,
        http: mcp?.http != null,
        acp: mcp?.acp != null,
      },
      ...(session == null
        ? {}
        : {
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
              ...(session.delete == null ? {} : { delete: {} }),
              ...(session.fork == null ? {} : { fork: {} }),
              ...(session.additionalDirectories == null ? {} : { additionalDirectories: {} }),
            },
          }),
      ...(response.capabilities?.providers == null ? {} : { providers: {} }),
      ...(response.authMethods === undefined || response.authMethods.length === 0
        ? {}
        : { auth: { logout: {} } }),
    },
    ...(response.authMethods === undefined
      ? {}
      : {
          authMethods: response.authMethods
            .map((method) => {
              const record = method as AcpSchemaV2.AuthMethod;
              const base = {
                id: record.methodId,
                name: record.name,
                ...(record.description === undefined ? {} : { description: record.description }),
                ...(record._meta === undefined ? {} : { _meta: record._meta }),
              };
              if (
                record.type === "env_var" &&
                Array.isArray(record.vars) &&
                record.vars.every(
                  (variable) =>
                    typeof variable === "object" &&
                    variable !== null &&
                    typeof (variable as { readonly name?: unknown }).name === "string",
                )
              ) {
                return {
                  ...base,
                  type: "env_var" as const,
                  vars: record.vars.map((variable) => {
                    const value = variable as { readonly name: string; readonly label?: unknown };
                    return {
                      name: value.name,
                      ...(typeof value.label === "string" ? { label: value.label } : {}),
                    };
                  }),
                  ...(typeof record.link === "string" ? { link: record.link } : {}),
                };
              }
              if (record.type === "agent") return { ...base, type: "agent" as const };
              if (record.type !== "terminal") return undefined;
              return {
                ...base,
                type: "terminal" as const,
                ...(Array.isArray(record.args)
                  ? {
                      args: record.args.filter(
                        (argument): argument is string => typeof argument === "string",
                      ),
                    }
                  : {}),
                ...(Array.isArray(record.env)
                  ? {
                      env: Object.fromEntries(
                        (record.env as ReadonlyArray<AcpSchemaV2.EnvVariable>).map((variable) => [
                          variable.name,
                          variable.value,
                        ]),
                      ),
                    }
                  : {}),
              };
            })
            .filter(Predicate.isNotUndefined),
        }),
    ...(response._meta === undefined ? {} : { _meta: response._meta }),
  };
}

function toV2InitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV2.InitializeRequest {
  const capabilities = request.clientCapabilities;
  return {
    protocolVersion: 2,
    info: request.clientInfo ?? { name: "t3-code", version: "unknown" },
    capabilities: {
      ...(capabilities?.auth?.terminal === true ? { auth: { terminal: {} } } : {}),
      ...(capabilities?.elicitation == null ? {} : { elicitation: capabilities.elicitation }),
      ...(capabilities?._meta === undefined ? {} : { _meta: capabilities._meta }),
    },
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}

export function toNegotiatingInitializeRequest(
  request: AcpSchema.InitializeRequest,
): AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest {
  return {
    ...toV2InitializeRequest(request),
    clientCapabilities: request.clientCapabilities ?? {},
    ...(request.clientInfo === undefined ? {} : { clientInfo: request.clientInfo }),
  } as unknown as AcpSchemaV1.InitializeRequest | AcpSchemaV2.InitializeRequest;
}

export function isV2InitializeResponse(
  response: AcpSchemaV1.InitializeResponse | AcpSchemaV2.InitializeResponse,
): response is AcpSchemaV2.InitializeResponse {
  return "info" in response;
}

export function normalizeV2SessionSetupResponse(
  response:
    | AcpSchemaV2.NewSessionResponse
    | AcpSchemaV2.ResumeSessionResponse
    | AcpSchemaV2.ForkSessionResponse,
) {
  const configOptions = normalizeConfigOptions(response.configOptions);
  return {
    ...("sessionId" in response ? { sessionId: response.sessionId } : {}),
    ...(configOptions === undefined ? {} : { configOptions }),
    ...(response._meta === undefined ? {} : { _meta: response._meta }),
  };
}

export function normalizePermissionRequest(
  request: AcpSchemaV2.RequestPermissionRequest,
  context: AcpProtocol.AcpRequestContext,
): AcpSchema.RequestPermissionRequest {
  const subject = request.subject;
  const toolCall =
    subject?.type === "tool_call" && "toolCall" in subject
      ? normalizeToolCallUpdate(subject.toolCall as AcpSchemaV2.ToolCallUpdate)
      : {
          toolCallId:
            subject?.type === "command" &&
            "toolCallId" in subject &&
            typeof subject.toolCallId === "string"
              ? subject.toolCallId
              : context.requestId,
          title: request.title,
          kind: subject?.type === "command" ? ("execute" as const) : ("other" as const),
        };
  return {
    sessionId: request.sessionId,
    title: request.title,
    ...(request.description === undefined ? {} : { description: request.description }),
    ...(subject === undefined ? {} : { subject }),
    toolCall,
    options: request.options,
    ...(request._meta === undefined ? {} : { _meta: request._meta }),
  };
}
