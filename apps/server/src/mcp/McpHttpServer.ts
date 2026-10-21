import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  type PreviewAutomationSnapshot,
  type RunId,
  ThreadId,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ConnectionHandlers from "./toolkits/connection/handlers.ts";
import { ConnectionToolkit } from "./toolkits/connection/tools.ts";
import * as MemoryHandlers from "./toolkits/memory/handlers.ts";
import { MemoryToolkit } from "./toolkits/memory/tools.ts";
import * as MemoryAdministrationHandlers from "./toolkits/memoryAdministration/handlers.ts";
import { MemoryAdministrationToolkit } from "./toolkits/memoryAdministration/tools.ts";
import * as NoteHandlers from "./toolkits/note/handlers.ts";
import { NoteToolkit } from "./toolkits/note/tools.ts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OpenCodexInventory from "../opencodex/OpenCodexInventory.ts";
import * as HubParity from "../hub/HubParity.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteReportService from "../remoteReports/RemoteReportService.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  MAX_REPORTED_DEPTH,
  toolOutcome,
} from "../telemetry/ProviderDimensions.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as HostStatusMcpService from "./HostStatusMcpService.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as PendingQuestionsMcpService from "./PendingQuestionsMcpService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as ThreadLaunchMcpService from "./ThreadLaunchMcpService.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as ThreadSearchMcpService from "./ThreadSearchMcpService.ts";
import * as WorktreeInventoryService from "./WorktreeInventoryService.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as ChannelHandlers from "./toolkits/channel/handlers.ts";
import { ChannelToolkit } from "./toolkits/channel/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as FleetHandlers from "./toolkits/fleet/handlers.ts";
import * as FleetHealthHandlers from "./toolkits/fleet/healthHandlers.ts";
import { FleetHealthToolkit } from "./toolkits/fleet/healthTools.ts";
import * as FleetResourcesHandlers from "./toolkits/fleet/resources/handlers.ts";
import { FleetResourcesToolkit } from "./toolkits/fleet/resources/tools.ts";
import { FleetToolkit } from "./toolkits/fleet/tools.ts";
import * as HostStatusHandlers from "./toolkits/hostStatus/handlers.ts";
import { HostStatusToolkit } from "./toolkits/hostStatus/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlPreviewTool, HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProviderHandlers from "./toolkits/provider/handlers.ts";
import { ProviderToolkit } from "./toolkits/provider/tools.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as RemoteReportHandlers from "./toolkits/remoteReport/handlers.ts";
import { RemoteReportToolkit } from "./toolkits/remoteReport/tools.ts";
import * as SshHandlers from "./toolkits/ssh/handlers.ts";
import { SshToolkit } from "./toolkits/ssh/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/**
 * Agents GOAT launched carry a registry token and must never be sent into an
 * OAuth flow when it dies: they cannot open a browser, and a sign-in would mint
 * a credential that outlives their session.
 */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
  readonly message?: string;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: input.message ?? GENERIC_REFUSAL,
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("goat/mcp/McpHttpServer/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

const GENERIC_REFUSAL = "A valid GOAT MCP credential is required.";
const RETRY_AT_NEXT_TURN =
  "GOAT re-authenticates the thread with a fresh credential when its next turn starts; retry this tool then.";

/** What the agent reads when its thread credential is refused. Names no thread or id. */
export const credentialRefusalMessage = (
  reason: McpSessionRegistry.McpCredentialRefusalReason,
): string => {
  switch (reason) {
    case "expired":
      return `GOAT refused this call: this thread's GOAT credential expired after GOAT stopped holding its provider session. ${RETRY_AT_NEXT_TURN}`;
    case "revoked":
      return `GOAT refused this call: GOAT closed the provider session this thread's GOAT credential belonged to. ${RETRY_AT_NEXT_TURN}`;
    case "earlier_server":
      return `GOAT refused this call: this thread's GOAT credential was issued before the GOAT server restarted or updated. ${RETRY_AT_NEXT_TURN}`;
    case "missing":
    case "unknown":
      return GENERIC_REFUSAL;
  }
};

const MAX_REFUSED_BODY_BYTES = 1024 * 1024;
/** An unauthenticated caller must not hold the read open; a slow body falls back to 401. */
const REFUSED_BODY_DEADLINE = "5 seconds";
const decodeToolCallRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      method: Schema.Literal("tools/call"),
      id: Schema.Union([Schema.String, Schema.Number]),
    }),
  ),
);

/**
 * MCP clients turn a 401 into their own generic text ("Authentication
 * required" in Codex), so a refused tool call is answered as an error result
 * the agent can read. Only for a registry-shaped token, never a session token
 * that may still sign in through OAuth, and nothing is executed.
 */
const refusedToolCallId = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const declared = request.headers["content-length"];
    if (
      request.method !== "POST" ||
      (declared !== undefined && !(Number(declared) <= MAX_REFUSED_BODY_BYTES))
    )
      return undefined;
    // Chunked bodies declare no length, so the read itself stops at the bound.
    let size = 0;
    const chunks = yield* request.stream.pipe(
      Stream.takeWhile((chunk) => (size += chunk.byteLength) <= MAX_REFUSED_BODY_BYTES),
      Stream.runCollect,
      Effect.timeoutOption(REFUSED_BODY_DEADLINE),
      Effect.option,
      Effect.map(Option.flatten),
    );
    if (Option.isNone(chunks) || size > MAX_REFUSED_BODY_BYTES) return undefined;
    return Option.getOrUndefined(
      Option.map(
        decodeToolCallRequest(Buffer.concat(chunks.value).toString("utf8")),
        (call) => call.id,
      ),
    );
  });

const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      const refusal: McpSessionRegistry.McpCredentialRefusal = registry.explainRefusal
        ? yield* registry.explainRefusal(token)
        : { reason: token.length === 0 ? "missing" : "unknown" };
      const registryToken = registry.isRegistryToken?.(token) === true;
      const toolCallId = registryToken ? yield* refusedToolCallId(request) : undefined;
      const details = {
        reason: refusal.reason,
        ...(refusal.threadId === undefined ? {} : { threadId: refusal.threadId }),
        ...(refusal.providerSessionId === undefined
          ? {}
          : { providerSessionId: refusal.providerSessionId }),
        ...(refusal.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: refusal.providerInstanceId }),
        ...(refusal.endedAt === undefined ? {} : { endedAt: refusal.endedAt }),
        registryToken,
        toolCall: toolCallId !== undefined,
      };
      yield* Effect.logWarning(
        "refused an MCP request whose credential does not resolve",
        details,
      ).pipe(
        Effect.withSpan("McpHttpServer.refuseCredential", {
          attributes: Object.fromEntries(
            Object.entries(details).map(([key, value]) => [`mcp.credential.${key}`, value]),
          ),
        }),
      );
      const message = credentialRefusalMessage(refusal.reason);
      if (toolCallId !== undefined)
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: toolCallId,
            result: { content: [{ type: "text", text: message }], isError: true },
          },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
        message,
      });
    }
    return yield* httpEffect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.map(normalizeMcpHttpResponse),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full accessibility
 * tree and page text loses its locators too. Claude Code also shows the model
 * `structuredContent` in place of the text blocks when a result has both, so
 * both carry the same bounded snapshot.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  const ariaTree = typeof accessibilityTree === "string" ? accessibilityTree : undefined;
  if (accessibilityTree !== undefined && ariaTree === undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB, and the caps count characters, not bytes.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  let ariaTreeChars = Math.min(ariaTree?.length ?? 0, 20_000);
  const value = () => ({
    ...bounded,
    ...(ariaTree === undefined ? {} : { accessibilityTree: cutText(ariaTree, ariaTreeChars) }),
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : ariaTreeChars > 0
            ? "accessibilityTree"
            : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else if (key === "accessibilityTree") {
      ariaTreeChars = Math.floor(ariaTreeChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      // slice(-0) keeps everything, so spell out the empty case.
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  if (ariaTree !== undefined && ariaTreeChars < ariaTree.length) {
    omitted.push(`accessibilityTree after ${ariaTreeChars} characters`);
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const crypto = yield* Crypto.Crypto;
  const unique = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

/**
 * Tool input schemas are advertised through each schema's JSON codec, which
 * offers `null` for every `Schema.optional` field, but Toolkit decodes with the
 * schema itself and rejects that `null`. Decoding through the same codec makes
 * a tool accept what it advertises.
 * Tools that advertise a raw JSON Schema (the memory tools) decode their strict
 * contracts in the handler, so they keep that schema.
 */
const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  // The clones keep each tool's id, name and decoded parameter type, so handlers still match.
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      Tool.isDynamic(tool) && tool.jsonSchema !== undefined
        ? tool
        : tool.setParameters(Schema.toCodecJson(tool.parametersSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const built = yield* decodeAsAdvertised(PreviewSnapshotToolkit);
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot: PreviewAutomationSnapshot["screenshot"];
              };
              const { screenshot, ...page } = snapshot;
              const { data: _data, ...screenshotMetadata } = screenshot;
              const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              // Images stay out of tool history unless asked for: providers replay them on every
              // later request, and some reject inline images outright.
              const includeImage = payload?.includeImage === true;
              if (screenshotPath !== undefined && !includeImage) {
                const saved = {
                  url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                  screenshotPath,
                  ...(screenshot.fullPage ? { screenshot: screenshotMetadata } : {}),
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: saved,
                  content: [{ type: "text", text: encodeJsonText(saved) }],
                });
              }
              const metadata = {
                ...page,
                screenshot: screenshotMetadata,
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent:
                  bounded.omitted.length === 0
                    ? bounded.value
                    : { ...bounded.value, omitted: bounded.omitted },
                content: [
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(includeImage
                    ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
                    : []),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag unless the tool describes them: the remote
 * message may carry renderer or device output the agent should not see, and the
 * tag is what it can act on.
 */
const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const message =
      typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error);
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the wrong
 * shape for a screenshot: the model needs image content.
 */
const registerImageTool = Effect.fn("McpHttpServer.registerImageTool")(function* <
  T extends Tool.Any,
  E,
  R,
>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string | ((error: E) => string),
) {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return provide(handle(payload as Tool.Parameters<T>)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: imageToolFailure(tool.name, operation, failureText),
            onSuccess: ({ encodedResult }) => {
              const { screenshot, ...rest } = encodedResult as ImageToolResult;
              const includeImage =
                (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                false;
              const metadata = {
                ...rest,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    ...(includeImage
                      ? [
                          {
                            type: "image" as const,
                            data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                            mimeType: screenshot.mimeType,
                          },
                        ]
                      : []),
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(DeviceScreenshotToolkit);
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "screenshot",
    "Device screenshot failed.",
  );
});

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const registerHtmlPreview = Effect.fn("McpHttpServer.registerHtmlPreview")(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(HtmlPreviewToolkit);
  yield* registerImageTool(
    HtmlPreviewTool,
    (payload) =>
      built
        .handle("html_preview", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(HtmlRender.HtmlRender, htmlRender),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "preview",

    (error) =>
      isOrchestratorMcpFailure(error) || AiError.isAiError(error)
        ? error.message
        : "HTML preview failed.",
  );
});

const encodeOrchestratorMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);

const undeclaredArgumentsResult = (
  tool: string,
  undeclared: ReadonlyArray<string>,
  declared: ReadonlyArray<string>,
) => {
  const accepted =
    declared.length === 0 ? `${tool} takes no arguments.` : `It takes ${declared.join(", ")}.`;
  const failure = new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `${tool} does not take ${undeclared.join(", ")}, so nothing ran. ${accepted}`,
  });
  return new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: JSON.stringify(encodeOrchestratorMcpFailure(failure)) }],
  });
};

const argumentKeys = (payload: unknown) =>
  typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? Object.keys(payload)
    : [];

/**
 * Runs tool registrations so that every tool they add refuses top-level
 * arguments it does not declare, before it runs.
 *
 * Effect's tool decoder drops unknown keys, so a misspelled or unsupported
 * routing argument (`hostId` for `host`, or `host` on a tool without one)
 * ran the call in this environment and answered with local data as if it came
 * from another machine. Nested values, such as a modelSelection copied from
 * another result, keep lenient decoding. The refusal is an ordinary
 * invalid_request result, which SshRemoteDispatch also reads back from a remote.
 */
const applyToolContracts = <A, E, R>(register: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const effects = yield* McpToolAccess.ToolEffects;
    return yield* register.pipe(
      Effect.provideService(
        McpServer.McpServer,
        McpServer.McpServer.of({
          ...server,
          addTool: (registration) => {
            const effect = effects[registration.tool.name];
            if (effect === undefined) {
              return Effect.die(
                new TypeError(`Missing access declaration for ${registration.tool.name}`),
              );
            }
            registration = {
              ...registration,
              tool: new McpSchema.Tool({
                ...registration.tool,
                annotations: {
                  ...registration.tool.annotations,
                  readOnlyHint: effect === "read",
                  destructiveHint: effect === "destructive",
                },
              }),
              annotations: registration.annotations.pipe(
                Context.add(Tool.Readonly, effect === "read"),
                Context.add(Tool.Destructive, effect === "destructive"),
              ),
            };
            const inputSchema = registration.tool.inputSchema;
            // A parameter schema with an index signature declares its own extra keys.
            if (typeof inputSchema.additionalProperties === "object")
              return server.addTool(registration);
            const properties = inputSchema.properties ?? {};
            return server.addTool({
              ...registration,
              tool: new McpSchema.Tool({
                ...registration.tool,
                inputSchema: { ...inputSchema, additionalProperties: false },
              }),
              handle: (payload) => {
                const undeclared = argumentKeys(payload).filter(
                  (key) => !Object.hasOwn(properties, key),
                );
                return undeclared.length === 0
                  ? registration.handle(payload)
                  : Effect.succeed(
                      undeclaredArgumentsResult(
                        registration.tool.name,
                        undeclared,
                        Object.keys(properties),
                      ),
                    );
              },
            });
          },
        }),
      ),
    );
  });

/**
 * Tools that hand work to another thread's agent: they create it, message it,
 * steer it, or move context into it. Their events name the receiving agent too.
 */
const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "goat_thread_launch",
  "goat_thread_send",
  "goat_thread_send_attachments",
  "goat_thread_fork",
  "goat_thread_merge_back",
  "goat_queue_edit",
  "goat_queue_promote_to_steer",
  "goat_pending_request_respond",
  "schedule_task",
  "run_scheduled_task_now",
]);

/** Handoff tools whose result is only `{ sequence }`; their input names the receiving thread. */
const INPUT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "goat_queue_edit",
  "goat_queue_promote_to_steer",
  "goat_pending_request_respond",
]);

const resultThreadKeys = ["childThreadId", "targetThreadId", "boundThreadId", "threadId"] as const;

/** Thread ids a handoff tool result names: the thread that received the work. */
const resultThreadIds = (content: unknown): ReadonlyArray<string> => {
  if (typeof content !== "object" || content === null) return [];
  const record = content as Readonly<Record<string, unknown>>;
  if (Array.isArray(record.threads)) return record.threads.flatMap(resultThreadIds);
  const key = resultThreadKeys.find((candidate) => typeof record[candidate] === "string");
  return key === undefined ? [] : [record[key] as string];
};

/**
 * Thread ids that received a handoff. The input's `threadId` is used only after
 * the call succeeded, so it is one the handler already resolved and authorized.
 */
const handoffTargetIds = (
  tool: string,
  args: unknown,
  result: McpSchema.CallToolResult | undefined,
): ReadonlyArray<string> => {
  if (!INPUT_TARGET_TOOLS.has(tool)) return resultThreadIds(result?.structuredContent);
  if (result === undefined || toolOutcome(result).outcome !== "ok") return [];
  const threadId = (args as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? [threadId] : [];
};

/**
 * Runs a tool registration against a server that records one anonymous
 * `mcp.tool.invoked` event per call: the tool, the calling agent's provider,
 * the outcome with its failure code, and the duration. A handoff tool also
 * reports the caller's model, origin, and delegation depth, the settings the
 * agent chose, and the provider, model, and modes of each thread that received
 * the work. Ids, prompts, and free text are never recorded.
 */
const withToolAnalytics =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* <A, E, R>(registration: Effect.Effect<A, E, R>) {
    const server = yield* McpServer.McpServer;
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    if (Option.isNone(analytics)) return yield* registration;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    const shellOf = (threadId: string) =>
      Option.isNone(threads)
        ? Effect.succeed(null)
        : threads.value
            .getThreadShell(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => null));
    // Delegation depth: parents walked from the caller, capped.
    const depthOf =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (thread: AgentThread) {
        let depth = 0;
        let parentId =
          thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
        while (parentId !== null && depth < MAX_REPORTED_DEPTH) {
          depth += 1;
          const parent = yield* shellOf(parentId);
          parentId =
            parent?.lineage.relationshipToParent === "subagent"
              ? parent.lineage.parentThreadId
              : null;
        }
        return depth;
      });
    // Whether the caller's active run was started by a scheduled task.
    const scheduledRunOf = (threadId: string, runId: RunId | null) =>
      Option.isNone(threads) || runId === null
        ? Effect.succeed(false)
        : threads.value
            .getThreadRecords(ThreadId.make(threadId), ["runs", "messages"], {
              runIds: [runId],
              messageRoles: ["user"],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((candidate) => candidate.id === runId);
                return records.messages.some(
                  (message) =>
                    message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
                );
              }),
              Effect.orElseSucceed(() => false),
            );
    const record =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (
          tool: string,
          args: unknown,
          result: McpSchema.CallToolResult | undefined,
          durationMs: number,
        ) {
          const toolName = tool.replace(/^t3_/, "goat_");
          // Client credentials (no calling thread) report an unknown caller.
          const invocation = Option.getOrUndefined(
            yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
          )?.thread;
          const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
          // Only handoff tools pay for thread lookups; the rest report the
          // caller's provider from the credential.
          const handoff = HANDOFF_TOOLS.has(toolName);
          const caller =
            handoff && invocation !== undefined
              ? ((yield* shellOf(invocation.threadId)) ?? undefined)
              : undefined;
          const targetIds = handoff
            ? [...new Set(handoffTargetIds(toolName, args, result))].filter(
                (threadId) => threadId !== invocation?.threadId,
              )
            : [];
          const targets = yield* Effect.forEach(targetIds, shellOf);
          for (const properties of agentToolProperties({
            tool: toolName,
            providers,
            caller,
            ...(invocation === undefined
              ? {}
              : { callerProviderInstanceId: invocation.providerInstanceId }),
            ...(caller === undefined || invocation === undefined
              ? {}
              : {
                  callerDepth: yield* depthOf(caller),
                  callerScheduledRun: yield* scheduledRunOf(
                    invocation.threadId,
                    caller.activeRunId,
                  ),
                }),
            targets: targets.filter((thread) => thread !== null),
            outcome: toolOutcome(result),
            ...(handoff
              ? { settings: handoffSettings(toolName, args, result?.structuredContent) }
              : {}),
            durationMs,
          })) {
            yield* analytics.value.record("mcp.tool.invoked", properties);
          }
        },
        (effect, _tool, _args, _result, _durationMs) => effect.pipe(Effect.ignoreCause),
      );
    const recordingServer = McpServer.McpServer.of({
      ...server,
      addTool: (options) =>
        server.addTool({
          ...options,
          handle:
            /* Request instrumentation already owns the span; keep this helper in that context. */
            Effect.fnUntraced(function* (payload) {
              const startedAt = yield* Clock.currentTimeMillis;
              return yield* options.handle(payload).pipe(
                Effect.onExit((exit) => {
                  const result = exit._tag === "Success" ? exit.value : undefined;
                  // A call that asks for input is retried with it, and that call is the one counted.
                  if (result instanceof McpSchema.InputRequired) return Effect.void;
                  // Handoff tools look up threads to record; the response must not wait on them.
                  return Clock.currentTimeMillis.pipe(
                    Effect.flatMap((endedAt) =>
                      record(options.tool.name, payload, result, endedAt - startedAt),
                    ),
                    Effect.forkDetach,
                    Effect.asVoid,
                  );
                }),
              );
            }),
        }),
    });
    return yield* registration.pipe(Effect.provideService(McpServer.McpServer, recordingServer));
  });

/**
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => {
  const registration = Layer.effectDiscard(
    withToolAnalytics(applyToolContracts(McpServer.registerToolkit(decodeAsAdvertised(toolkit)))),
  ).pipe(Layer.provide(McpServer.McpServer.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(withToolAnalytics(applyToolContracts(register))).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
  );

/** The registration layers mounted by /mcp, including image and memory tools.
 * Kept separate from domain construction so catalog contracts can be checked without live state. */
export const catalogRegistrations = {
  htmlRender: toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  htmlPreview: imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
  previewStandard: toolkitRegistration(PreviewStandardToolkit, PreviewHandlers.layerStandard),
  previewSnapshot: imageToolRegistration(registerPreviewSnapshot(), PreviewHandlers.layerSnapshot),
  orchestrator: toolkitRegistration(OrchestratorToolkit, OrchestratorHandlers.layer),
  thread: toolkitRegistration(ThreadToolkit, ThreadHandlers.layer),
  worktree: toolkitRegistration(WorktreeToolkit, WorktreeHandlers.layer),
  previewControls: toolkitRegistration(PreviewControlsToolkit, PreviewControlsHandlers.layer),
  environment: toolkitRegistration(EnvironmentToolkit, EnvironmentHandlers.layer),
  hostStatus: toolkitRegistration(HostStatusToolkit, HostStatusHandlers.layer),
  fleetHealth: toolkitRegistration(FleetHealthToolkit, FleetHealthHandlers.layer),
  fleet: toolkitRegistration(FleetToolkit, FleetHandlers.layer),
  fleetResources: toolkitRegistration(FleetResourcesToolkit, FleetResourcesHandlers.layer),
  provider: toolkitRegistration(ProviderToolkit, ProviderHandlers.layer),
  project: toolkitRegistration(ProjectToolkit, ProjectHandlers.layer),
  connection: toolkitRegistration(ConnectionToolkit, ConnectionHandlers.layer),
  remoteReport: toolkitRegistration(RemoteReportToolkit, RemoteReportHandlers.layer),
  ssh: toolkitRegistration(SshToolkit, SshHandlers.layer),
  attachment: toolkitRegistration(AttachmentToolkit, AttachmentHandlers.layer),
  note: toolkitRegistration(NoteToolkit, NoteHandlers.layer),
  channel: toolkitRegistration(ChannelToolkit, ChannelHandlers.layer),
  pullRequests: toolkitRegistration(PullRequestsToolkit, PullRequestsHandlers.layer),
  deviceStandard: toolkitRegistration(DeviceStandardToolkit, DeviceHandlers.layerStandard),
  deviceScreenshot: imageToolRegistration(
    registerDeviceScreenshot(),
    DeviceHandlers.layerScreenshot,
  ),
  memory: toolkitRegistration(MemoryToolkit, MemoryHandlers.layer),
  memoryAdministration: toolkitRegistration(
    MemoryAdministrationToolkit,
    MemoryAdministrationHandlers.layer,
  ),
};

export const layerHtmlToolkit = Layer.mergeAll(
  catalogRegistrations.htmlRender,
  catalogRegistrations.htmlPreview,
).pipe(Layer.provide(HtmlRender.layer));

const layerPreviewStandardToolkitRegistration = catalogRegistrations.previewStandard;

const layerPreviewSnapshotRegistration = catalogRegistrations.previewSnapshot;

export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
);

export const layerOrchestratorToolkit = catalogRegistrations.orchestrator.pipe(
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(ThreadMetadataMcpService.layer),
);

export const layerThreadToolkit = catalogRegistrations.thread.pipe(
  Layer.provide(ThreadSearchMcpService.layer),
  Layer.provide(PendingQuestionsMcpService.layer),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
);

const layerWorktreeToolkitRegistration = catalogRegistrations.worktree.pipe(
  Layer.provide(WorktreeMcpService.layer),
  Layer.provide(WorktreeInventoryService.layer),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
);

const layerPreviewControlsRegistration = catalogRegistrations.previewControls;

export const layerEnvironmentToolkit = catalogRegistrations.environment.pipe(
  Layer.provide(ThreadCommandExecutor.layer),
);

/**
 * Host status for both the goat_host_status tool and the `server.getHostStatus`
 * WebSocket RPC. Provide it once above both, so they read one instance and
 * share its last-known samples and quota refresh limit. LaunchWatchService and
 * RemoteDispatchCoordinator are left to the caller, like `layer`.
 */
export const layerHostStatusService = HostStatusMcpService.layer.pipe(
  Layer.provideMerge(HubParity.layer),
  Layer.provide(OpenCodexInventory.layer.pipe(Layer.provide(ProcessRunner.layer))),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(RemoteReportService.layer),
  Layer.provide(ThreadResultService.layer),
);

/** Reads HostStatusMcpService from the server's context; see `layerHostStatusService`. */
export const layerHostStatusToolkit = catalogRegistrations.hostStatus;

/** goat_goal_*. The server provides GoalService with the controller (fleet/goals/GoalLayers). */
export const layerFleetToolkit = catalogRegistrations.fleet;
/** Reads Placement and FallbackChains from the server's context, like host status. */
export const layerFleetResourcesToolkit = catalogRegistrations.fleetResources;

/**
 * goat_provider_diagnose. Composed beside `layer` by the server, which provides
 * ProviderDiagnosisService and CodexHomeRequests are shared application services.
 * The approval tool uses the same mutation singleton as authenticated Settings.
 */
export const layerProviderToolkit = catalogRegistrations.provider;

const layerProjectRegistration = catalogRegistrations.project.pipe(
  Layer.provide(ThreadLaunchMcpService.layer),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
);

export const layerConnectionToolkit = catalogRegistrations.connection;

const layerRemoteReportRegistration = catalogRegistrations.remoteReport;

const layerSshToolkitRegistration = catalogRegistrations.ssh;

export const layerAttachmentToolkit = catalogRegistrations.attachment;

const layerChannelToolkit = catalogRegistrations.channel;

export const layerPullRequestsToolkit = catalogRegistrations.pullRequests;

const layerDeviceStandardToolkitRegistration = catalogRegistrations.deviceStandard;

const layerDeviceScreenshotRegistration = catalogRegistrations.deviceScreenshot;

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

export const layerMcpTransport = McpServer.layerHttp({
  name: "GOAT",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
}).pipe(Layer.provide(layerMcpAuthMiddleware));

export const layer = Layer.mergeAll(
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerThreadToolkit,
  layerAttachmentToolkit,
  layerChannelToolkit,
  catalogRegistrations.note,
  layerProjectRegistration,
  layerEnvironmentToolkit,
  layerHostStatusToolkit,
  catalogRegistrations.fleetHealth,
  layerFleetResourcesToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerHtmlToolkit,
  layerSshToolkitRegistration,
  layerConnectionToolkit,
  layerRemoteReportRegistration,
).pipe(
  // LaunchWatchService and RemoteDispatchCoordinator are left to the caller:
  // the server provides one of each for these tools and the remote-launch
  // catalog, since both follow runs and wake launchers.
  // One report service for the launch binding and the report tools, so a
  // report wakes the origin's waiting collector.
  Layer.provide(RemoteReportService.layer),
  // Run results for the report tool and the thread read and wait tools.
  Layer.provide(ThreadResultService.layer),
  Layer.provideMerge(layerMcpTransport),
);

// L5 composes these after the domain and committed policy producers are ready.
export const layerMemoryToolkit = catalogRegistrations.memory;
export const layerMemoryAdministrationToolkit = catalogRegistrations.memoryAdministration;

export const __testing = { refusedToolCallId };
