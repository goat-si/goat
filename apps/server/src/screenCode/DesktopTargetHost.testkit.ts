import * as Effect from "effect/Effect";
import type {
  ComputerUsePrimitiveReply,
  ScreenHostCall,
  ScreenTargetRef,
  ThreadId,
} from "@goat/contracts";
import type { ComputerUsePrimitiveChannel } from "../cua/ComputerUsePrimitiveChannel.ts";
import type { ComputerUseLeases } from "../cua/ComputerUseLeases.ts";
import { createDesktopTargetHost } from "./DesktopTargetHost.ts";
import { ScreenObservations } from "./ScreenObservations.ts";
import type { ScreenHostContext } from "./ScreenHostBridge.ts";
import { screenRunLimits } from "./ScreenRunLimits.ts";

/** Fixtures for DesktopTargetHost tests: a primitive channel that answers like the driver. */
export const context = {
  runId: "r",
  turnId: "t",
  cellId: "c",
  threadId: "thread",
  environmentId: "env",
  limits: screenRunLimits(),
  invocation: { thread: { threadId: "thread" as ThreadId } },
} as ScreenHostContext;
export const call = (
  method: ScreenHostCall["method"],
  args: ScreenHostCall["args"] = {},
  targetRef?: ScreenTargetRef,
): ScreenHostCall => ({
  t: "call",
  runId: "r",
  turnId: "t",
  cellId: "c",
  callId: 1,
  method,
  args,
  deadlineMillis: 1000,
  ...(targetRef ? { targetRef } : {}),
});
export const apps = { apps: [{ pid: 42, name: "Editor", bundle_id: "org.example.Editor" }] };
export const windows = { windows: [{ pid: 42, window_id: 7, title: "Document" }] };
export const state = {
  pid: 42,
  window_id: 7,
  tree_markdown: "Apply",
  elements_complete: true,
  elements: [{ role: "button", label: "Apply", element_token: "snapshot:1" }],
};

// Reads shaped as cua-driver-rs-v0.38.0-goat.2 returns them (core window_state_view.rs apply,
// macOS get_window_state.rs): tokens are <snapshot_id>:N, elements_complete is always false.
const goat2Element = (snapshot: string, index: number, role: string, label: string) => ({
  role,
  depth: 1,
  element_index: index,
  element_token: `${snapshot}:${index}`,
  label,
});
const goat2Full = (snapshot: string) => ({
  window_id: 7,
  pid: 42,
  element_count: 2,
  returned_element_count: 2,
  elements_complete: false,
  snapshot_id: snapshot,
  tree_markdown: '- [0] AXWindow "Document"\n  - [1] AXButton "Apply" [actions=[press]]',
  elements: [
    goat2Element(snapshot, 0, "AXWindow", "Document"),
    goat2Element(snapshot, 1, "AXButton", "Apply"),
  ],
});
/** goat.2 keeps only the requested tree representation; markdown is its default. */
const goat2Read = (read: ReturnType<typeof goat2Full>, args: Record<string, unknown>) => {
  const format = typeof args.tree_format === "string" ? args.tree_format : "markdown";
  const { elements, tree_markdown, ...rest } = read;
  return {
    ...rest,
    tree_format: format,
    ...(format === "markdown" ? {} : { elements }),
    ...(format === "elements" ? {} : { tree_markdown }),
  };
};
export const goat2WindowState = (
  args: Record<string, unknown>,
  screenshot: Record<string, unknown> = { snapshot_id: "s0000000a" },
) =>
  args.include_accessibility_tree === false
    ? {
        window_id: 7,
        pid: 42,
        elements_complete: false,
        tree_markdown: "",
        tree_format: "markdown",
        screenshot_width: 100,
        screenshot_height: 80,
        screenshot_mime_type: "image/png",
        window_bounds: { x: 10, y: 20, width: 50, height: 40 },
        screenshot_scale: 2,
        image: {
          mimeType: "image/png",
          bytes: Buffer.from("png").toString("base64"),
          width: 100,
          height: 80,
        },
        ...screenshot,
      }
    : goat2Read(goat2Full("s0000000a"), args);

/** A driver tools/call answer with isError, as the lease proxy forwards a refusal. */
export class DriverError {
  readonly structuredContent: Record<string, unknown>;
  /** The reply's text block: what the driver or GOAT told the agent. */
  readonly text: string | undefined;
  constructor(structuredContent: Record<string, unknown>, text?: string) {
    this.structuredContent = structuredContent;
    this.text = text;
  }
}
/** A successful driver result with structured data and its text content. */
export class DriverSuccess {
  constructor(
    readonly structuredContent: Record<string, unknown>,
    readonly text: string,
  ) {}
}
/** A call GOAT refused before the driver: the proxy answers not_started with its refusal. */
export class NotStarted extends DriverError {}
/** A call cut off after it reached the driver: the proxy answers unknown_outcome. */
export class UnknownOutcome extends DriverError {}
// The typed refusal fields the lease proxy adds to a driver reply it refused.
export const typedRefusal = {
  effect: "refused",
  refused: "appNotAllowed",
  detail: "app_not_approved",
  app: "org.example.Editor",
};

export const fixture = (
  override: Partial<Record<string, unknown>> = {},
  connection = { id: "driver:1" },
  observations?: ScreenObservations,
  labelTarget?: Parameters<typeof createDesktopTargetHost>[0]["labelTarget"],
  // Launch arguments depend on the platform; tests pin macOS so they read the same on every runner.
  platform: NodeJS.Platform = "darwin",
) => {
  const sent: Array<{
    tool: string;
    args: unknown;
    expectedConnectionGeneration?: string;
    cursor?: { owner: unknown; point?: unknown };
  }> = [];
  const channel = {
    request: (request: {
      tool: string;
      args: unknown;
      expectedConnectionGeneration?: string;
      cursor?: { owner: unknown; point?: unknown };
    }) =>
      request.expectedConnectionGeneration !== undefined &&
      request.expectedConnectionGeneration !== connection.id
        ? Effect.fail({
            code: "stale_reference" as const,
            effectStarted: false,
            nextStep: "Bind again.",
          })
        : Effect.sync(() => {
            sent.push({
              tool: request.tool,
              args: request.args,
              ...(request.expectedConnectionGeneration === undefined
                ? {}
                : { expectedConnectionGeneration: request.expectedConnectionGeneration }),
              ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            });
            const answer =
              override[request.tool] ??
              (request.tool === "list_apps"
                ? apps
                : request.tool === "list_windows"
                  ? windows
                  : request.tool === "get_window_state"
                    ? state
                    : { effect: "confirmed", evidence: ["driver:acted"] });
            const value =
              typeof answer === "function"
                ? (answer as (args: unknown) => unknown)(request.args)
                : answer;
            return {
              status:
                value instanceof NotStarted
                  ? "not_started"
                  : value instanceof UnknownOutcome
                    ? "unknown_outcome"
                    : "settled",
              connectionGeneration: connection.id,
              result:
                value instanceof DriverError
                  ? {
                      isError: true,
                      structuredContent: value.structuredContent,
                      ...(value.text === undefined
                        ? {}
                        : { content: [{ type: "text", text: value.text }] }),
                    }
                  : value instanceof DriverSuccess
                    ? {
                        structuredContent: value.structuredContent,
                        content: [{ type: "text", text: value.text }],
                      }
                    : { structuredContent: value },
              ...(request.tool === "get_window_state" &&
              typeof (value as { image?: unknown }).image === "object"
                ? { image: (value as { image: unknown }).image }
                : {}),
            } as unknown as ComputerUsePrimitiveReply;
          }),
  } as unknown as ComputerUsePrimitiveChannel["Service"];
  const leases = {
    currentControl: () => Effect.succeedSome({ controlId: "control" }),
    controlState: () => Effect.succeed({ _tag: "active", idle: false }),
    releaseForeground: () => Effect.succeed(true),
  } as unknown as ComputerUseLeases["Service"];
  return {
    host: createDesktopTargetHost({
      primitiveChannel: channel,
      leases,
      ...(observations ? { observations } : {}),
      ...(labelTarget ? { labelTarget } : {}),
      platform,
    }),
    sent,
    channel,
    leases,
  };
};
