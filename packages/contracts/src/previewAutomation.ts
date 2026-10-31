import { ActionOutcomeSafety } from "./actionOutcomeSafety.ts";
import { Schema } from "effect";
import { DiagnosticFilter, DiagnosticSince } from "./previewLogsFilters.ts";
import {
  PreviewAutomationControlReason,
  PreviewAutomationTabControl,
  PreviewAutomationTabOwner,
  previewControlMessage,
} from "./previewAutomationControl.ts";
import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewRenderedViewportSize,
  PreviewTabId,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewViewportSize,
} from "./preview.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { BrowserProfileId } from "./browserProfile.ts";
import * as Session from "./previewAutomationSession.ts";
import * as Screen from "./previewAutomationScreen.ts";
import { PreviewWaitStateFields, waitStateConflict } from "./previewWaitState.ts";
import {
  PreviewAutomationFeature,
  PreviewAutomationConsoleEntry,
  PreviewAutomationNetworkEntry,
  PreviewAutomationPageError,
} from "./previewAutomationSnapshot.ts";
import { PreviewAutomationReadError } from "./previewAutomationRead.ts";
export * from "./previewAutomationSnapshot.ts";
export * from "./previewAutomationRead.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));
const URL_GUIDANCE = "Absolute http(s) URL, or a bare host (https; http for loopback).";
const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
).annotate({ description: "Default 15000." });

export const PREVIEW_AUTOMATION_V1_OPERATIONS = [
  "status",
  "open",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "recordingStart",
  "recordingStop",
] as const;

const PREVIEW_AUTOMATION_OPERATIONS = [
  ...PREVIEW_AUTOMATION_V1_OPERATIONS,
  "resize",
  "setColorScheme",
] as const;

export const PREVIEW_AUTOMATION_SERVER_OPERATIONS = [
  ...PREVIEW_AUTOMATION_OPERATIONS,
  "dialog",
  "close",
  "upload",
  "hover",
  "select",
  "drag",
  "back",
  "forward",
  "reload",
  "logs",
  "fetch",
  "scrollCollect",
  "fillSecret",
  "read",
  "signInState",
] as const;
export const PreviewAutomationOperation = Schema.Literals(PREVIEW_AUTOMATION_SERVER_OPERATIONS);
export type PreviewAutomationOperation = typeof PreviewAutomationOperation.Type;

const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(PreviewTabId),
};

export const PreviewAutomationTabTargetInput = Schema.Struct(PreviewAutomationTabTargetFields);
export type PreviewAutomationTabTargetInput = typeof PreviewAutomationTabTargetInput.Type;

/**
 * Whether this server's own headless browser can start, which needs no desktop app. `installed`
 * means an executable is present; only preview.open proves it launches.
 */
export const ServerBrowserReadinessState = Schema.Literals([
  "installed",
  "installs_on_open",
  "installing",
  "install_failed",
  "blocked",
  "unsupported",
]);
export type ServerBrowserReadinessState = typeof ServerBrowserReadinessState.Type;

export const ServerBrowserReadiness = Schema.Struct({
  state: ServerBrowserReadinessState,
  reason: Schema.String,
});
export type ServerBrowserReadiness = typeof ServerBrowserReadiness.Type;

export const PreviewAutomationStatus = Schema.Struct({
  available: Schema.Boolean,
  /** On the server browser's status without a tab; desktop hosts and older servers omit it. */
  browser: ForwardCompatibleOptional(ServerBrowserReadiness),
  visible: Schema.Boolean,
  tabId: Schema.NullOr(PreviewTabId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  /** Server hosts: moves on every main-frame navigation, so screenshot points from an older one fail. */
  documentGeneration: Schema.optional(Schema.Number),
  control: Schema.optional(PreviewAutomationTabControl),
  dialog: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.String,
        message: Schema.String,
        defaultValue: Schema.String,
      }),
    ),
  ),
  viewportSetting: Schema.optional(PreviewViewportSetting),
  viewport: Schema.optional(PreviewRenderedViewportSize),
  fileChooser: Schema.optional(
    Schema.NullOr(Schema.Struct({ multiple: Schema.Boolean, accept: Schema.String })),
  ),
  downloads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        fileName: Schema.String,
        path: Schema.String,
        sizeBytes: Schema.Number,
        url: Schema.String,
        completedAt: Schema.String,
      }),
    ).annotate({
      description:
        "Saved files. A tab's newest 20 stay on disk after it closes, until storage cleanup.",
    }),
  ),
  /** Server hosts: all thread tabs are readable; actions require ownedByCaller or an unclaimed tab without human control. */
  tabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        tabId: PreviewTabId,
        url: Schema.NullOr(Schema.String),
        openerTabId: Schema.optional(PreviewTabId),
        owner: Schema.optional(PreviewAutomationTabOwner),
        ownedByCaller: Schema.optional(Schema.Boolean),
        visible: Schema.optional(Schema.Boolean),
        profileId: Schema.optional(BrowserProfileId),
        session: Schema.optional(Session.PreviewTabSession),
      }),
    ),
  ),
  profiles: Schema.optional(Schema.Array(Session.PreviewAutomationProfile)),
  defaultProfileId: Schema.optional(BrowserProfileId),
  session: Schema.optional(Session.PreviewTabSession),
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatus.Type;

export const PreviewAutomationDialogInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  accept: Schema.Boolean,
  promptText: Schema.optional(Schema.String),
});
export type PreviewAutomationDialogInput = typeof PreviewAutomationDialogInput.Type;

export const PreviewAutomationOpenInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `First page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
  }),
  open: Schema.optional(
    Schema.Boolean.annotate({
      description: "Show the preview to the user. Default true. False for background only.",
    }),
  ),
  show: Schema.optional(
    Schema.Boolean.annotate({
      description: "Old alias for `open`.",
    }),
  ),
  reuseExistingTab: Schema.optional(
    Schema.Boolean.annotate({
      description: "Reuse `tabId`, or your current tab. Default true. False makes a new tab.",
    }),
  ),
  profileId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).annotate({
    description: Session.PROFILE_GUIDANCE,
  }),
  session: Schema.optional(Session.PreviewSessionMode).annotate({
    description: Session.PREVIEW_SESSION_GUIDANCE,
  }),
}).check(Session.openInputRule);
export type PreviewAutomationOpenInput = typeof PreviewAutomationOpenInput.Type;

export const BrowserNavigationTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("url"),
    url: BoundedUrl.annotate({
      description: `Website URL. ${URL_GUIDANCE}`,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("environment-port"),
    port: Schema.Int.check(Schema.isGreaterThan(0))
      .check(Schema.isLessThan(65_536))
      .annotate({ description: "Dev-server port here." }),
    protocol: Schema.optional(
      Schema.Literals(["http", "https"]).annotate({
        description: "Default http.",
      }),
    ),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Path, query, and fragment, such as /settings?tab=account.",
      }),
    ),
  }),
]);
export type BrowserNavigationTarget = typeof BrowserNavigationTarget.Type;

export const PreviewAutomationNavigateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(BoundedUrl).annotate({
    description: `Website URL. ${URL_GUIDANCE} For public pages.`,
  }),
  target: Schema.optional(BrowserNavigationTarget),
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded", "none"])).annotate({
    description: "Default 'load'. 'none': return at once.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.url !== undefined) + Number(input.target !== undefined) === 1 ||
      "Provide exactly one of url or target.",
  ),
);
export type PreviewAutomationNavigateInput = typeof PreviewAutomationNavigateInput.Type;

export const PreviewAutomationHistoryInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  readiness: Schema.optional(Schema.Literals(["load", "domContentLoaded"])).annotate({
    description:
      "Readiness milestone after navigation commits: load (default) or domContentLoaded for an interactive document.",
  }),
  timeoutMs: OptionalTimeoutMs,
});
export type PreviewAutomationHistoryInput = typeof PreviewAutomationHistoryInput.Type;

export const PreviewAutomationReloadInput = Schema.Struct({
  ...PreviewAutomationHistoryInput.fields,
  ignoreCache: Schema.optional(Schema.Boolean).annotate({
    description: "Bypass Chromium's HTTP cache for this reload. Defaults to false.",
  }),
});
export type PreviewAutomationReloadInput = typeof PreviewAutomationReloadInput.Type;

export const PreviewAutomationResizeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  mode: Schema.Literals(["fill", "freeform", "preset"]),
  preset: Schema.optional(PreviewViewportPresetId),
  width: Schema.optional(PreviewViewportSize.fields.width),
  height: Schema.optional(PreviewViewportSize.fields.height),
  orientation: Schema.optional(Schema.Literals(["portrait", "landscape"])),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    const hasPreset = input.preset !== undefined;
    const hasWidth = input.width !== undefined;
    const hasHeight = input.height !== undefined;
    if (hasWidth !== hasHeight) return "Custom dimensions require both width and height.";
    if (input.mode === "fill") {
      return !hasPreset && !hasWidth && input.orientation === undefined
        ? true
        : "Fill mode does not accept a preset, dimensions, or orientation.";
    }
    if (input.mode === "freeform") {
      if (!hasWidth || !hasHeight || hasPreset || input.orientation !== undefined) {
        return "Freeform mode requires width and height and does not accept a preset or orientation.";
      }
    } else if (!hasPreset || hasWidth || hasHeight) {
      return "Preset mode requires a preset and does not accept custom dimensions.";
    }
    if (hasWidth && hasHeight && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
      return `Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`;
    }
    return true;
  }),
);
export type PreviewAutomationResizeInput = typeof PreviewAutomationResizeInput.Type;

export const PreviewAutomationResizeResult = Schema.Struct({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});
export type PreviewAutomationResizeResult = typeof PreviewAutomationResizeResult.Type;

// Mirrors DesktopPreviewColorScheme without importing ipc.ts.
export const PreviewAutomationColorScheme = Schema.Literals(["system", "light", "dark"]);
export type PreviewAutomationColorScheme = typeof PreviewAutomationColorScheme.Type;

export const PreviewAutomationSetColorSchemeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeInput = typeof PreviewAutomationSetColorSchemeInput.Type;

export const PreviewAutomationSetColorSchemeResult = Schema.Struct({
  tabId: PreviewTabId,
  colorScheme: PreviewAutomationColorScheme,
});
export type PreviewAutomationSetColorSchemeResult =
  typeof PreviewAutomationSetColorSchemeResult.Type;

const Locator = TrimmedNonEmptyString;
const LegacySelector = TrimmedNonEmptyString;

const PointerTargetFields = {
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  timeoutMs: OptionalTimeoutMs,
};

const singlePointerTarget = Schema.makeFilter(
  (input: {
    readonly selector?: string | undefined;
    readonly locator?: string | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
  }) => {
    const selectorModes =
      Number(input.selector !== undefined) + Number(input.locator !== undefined);
    const hasX = input.x !== undefined;
    const hasY = input.y !== undefined;
    if (hasX !== hasY) return "Coordinates require both x and y.";
    const coordinateModes = hasX && hasY ? 1 : 0;
    return selectorModes + coordinateModes === 1 || "Provide exactly one target.";
  },
);

export const PreviewAutomationClickInput = Schema.Struct({
  ...PointerTargetFields,
  button: Schema.optional(
    Schema.Literals(["left", "right", "middle"]).annotate({
      description: "Button. Default left. Right opens the menu.",
    }),
  ),
  clickCount: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })).annotate({
      description: "1 click, 2 double, 3 triple. Default 1.",
    }),
  ),
}).check(singlePointerTarget);
export type PreviewAutomationClickInput = typeof PreviewAutomationClickInput.Type;

export const PreviewAutomationHoverInput =
  Schema.Struct(PointerTargetFields).check(singlePointerTarget);
export type PreviewAutomationHoverInput = typeof PreviewAutomationHoverInput.Type;

export const PreviewAutomationSelectInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  values: Schema.Array(Schema.String).check(Schema.isMaxLength(100)).annotate({
    description: "Empty clears it.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.selector !== undefined) + Number(input.locator !== undefined) === 1 ||
      "Provide exactly one of selector or locator.",
  ),
);
export type PreviewAutomationSelectInput = typeof PreviewAutomationSelectInput.Type;

export const PreviewAutomationSelectResult = Schema.Struct({
  selected: Schema.Array(Schema.String).annotate({
    description: "The values of the options now selected.",
  }),
});
export type PreviewAutomationSelectResult = typeof PreviewAutomationSelectResult.Type;

const PagePoint = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const PreviewAutomationDragInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  source: Schema.optional(Locator),
  target: Schema.optional(Locator),
  from: Schema.optional(PagePoint).annotate({
    description: "Viewport point where the drag starts, for maps and canvases without elements.",
  }),
  to: Schema.optional(PagePoint),
  steps: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
      description: "Pointer moves between from and to. Default 10.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      (input.source !== undefined &&
        input.target !== undefined &&
        input.from === undefined &&
        input.to === undefined) ||
      (input.from !== undefined &&
        input.to !== undefined &&
        input.source === undefined &&
        input.target === undefined) ||
      "Provide source and target locators, or from and to points.",
  ),
);
export type PreviewAutomationDragInput = typeof PreviewAutomationDragInput.Type;

export const PreviewAutomationUploadInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  paths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(20)),
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator).annotate({
    description: "Set files on this <input type=file> instead of the open picker.",
  }),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationUploadInput = typeof PreviewAutomationUploadInput.Type;

export const PreviewAutomationTypeInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  text: Schema.String,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  clear: Schema.optional(
    Schema.Boolean.annotate({
      description: "Clear the input first. Default false.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.selector !== undefined && input.locator !== undefined) ||
      "Provide at most one of selector or locator.",
  ),
);
export type PreviewAutomationTypeInput = typeof PreviewAutomationTypeInput.Type;

export const PreviewAutomationPressInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String.check(Schema.isTrimmed()).check(Schema.isNonEmpty()),
  modifiers: Schema.optional(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});
export type PreviewAutomationPressInput = typeof PreviewAutomationPressInput.Type;

export const PreviewAutomationScrollInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  x: Schema.optional(Schema.Finite).annotate({
    description: "With y, send a real wheel at this viewport point, as for zooming a map.",
  }),
  y: Schema.optional(Schema.Finite),
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    if ((input.x === undefined) !== (input.y === undefined)) return "Provide x and y together.";
    if (input.x !== undefined && (input.selector !== undefined || input.locator !== undefined))
      return "Provide a point or a locator, not both.";
    return input.deltaX !== undefined || input.deltaY !== undefined || "Provide deltaX or deltaY.";
  }),
);
export type PreviewAutomationScrollInput = typeof PreviewAutomationScrollInput.Type;

export const PreviewAutomationEvaluateInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  expression: Schema.String.check(Schema.isTrimmed())
    .check(Schema.isNonEmpty())
    .check(Schema.isMaxLength(64_000)),
  awaitPromise: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  returnByValue: Schema.optional(
    Schema.Boolean.annotate({
      description: "False returns a ref. Default true.",
    }),
  ),
});
export type PreviewAutomationEvaluateInput = typeof PreviewAutomationEvaluateInput.Type;

export const PreviewAutomationWaitForInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  selector: Schema.optional(LegacySelector),
  locator: Schema.optional(Locator),
  text: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Case counts.",
  }),
  state: Schema.optional(Schema.Literals(["attached", "visible", "hidden", "detached"])).annotate({
    description:
      "Needs locator or selector. Default attached (present, even hidden). Hidden also matches detached.",
  }),
  loadState: Schema.optional(Schema.Literals(["load", "domContentLoaded", "networkIdle"])).annotate(
    {
      description:
        "Load milestone to wait for. networkIdle waits for 500ms without connections. Shares timeoutMs; none by default.",
    },
  ),
  urlIncludes: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: OptionalTimeoutMs,
  ...PreviewWaitStateFields,
}).check(
  Schema.makeFilter((input) => {
    if (input.selector !== undefined && input.locator !== undefined) {
      return "Provide at most one of selector or locator.";
    }
    const conflict = waitStateConflict(input);
    if (conflict !== undefined) return conflict;
    return (
      input.selector !== undefined ||
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined ||
      input.loadState !== undefined ||
      "Provide at least one wait condition."
    );
  }),
);
export type PreviewAutomationWaitForInput = typeof PreviewAutomationWaitForInput.Type;

export const PreviewAutomationLogsInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  since: Schema.optional(DiagnosticSince),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate(
    {
      description:
        "Maximum entries per stream, newest first. Defaults to 50; maximum 100. A shared byte budget may return fewer.",
    },
  ),
  includeConsole: Schema.optional(Schema.Boolean).annotate({
    description: "Include console entries. Defaults to true.",
  }),
  includeErrors: Schema.optional(Schema.Boolean).annotate({
    description: "Include uncaught page errors and stacks. Defaults to true.",
  }),
  includeNetwork: Schema.optional(Schema.Boolean).annotate({
    description: "Include network metadata. Defaults to true.",
  }),
  consoleLevels: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(Schema.isMaxLength(20)),
  ).annotate({
    description:
      "Exact Playwright console levels to include, such as log, info, warning, error or debug. Omit for all levels.",
  }),
  text: Schema.optional(DiagnosticFilter).annotate({
    description:
      "Case-insensitive substring of console text or page error message/stack, after URL redaction.",
  }),
  url: Schema.optional(DiagnosticFilter).annotate({
    description:
      "Case-insensitive substring of the redacted network URL; query values cannot be searched.",
  }),
  method: Schema.optional(Schema.String.check(Schema.isMaxLength(32))).annotate({
    description: "Exact HTTP method, case-insensitive, such as GET or POST.",
  }),
  status: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ).annotate({
    description:
      "Exact HTTP response status (100 through 599). Request/failure entries without a response do not match.",
  }),
  failed: Schema.optional(Schema.Boolean).annotate({
    description:
      "Filter transport failures; HTTP 4xx/5xx responses are not failed requests. Omit for both.",
  }),
}).annotate({
  description:
    "Read retained diagnostics, newest first. All streams default to included; limit defaults to 50 per stream (maximum 100), subject to a shared 24 KB entry budget. Filters are case-insensitive substrings except exact console levels, HTTP status, method and failed. URL filtering uses redacted URLs. text filters console text and error message/stack. Reads do not clear buffers.",
});
export type PreviewAutomationLogsInput = typeof PreviewAutomationLogsInput.Type;

const DiagnosticCounts = {
  droppedCount: Schema.Int.annotate({
    description: "Entries evicted from this tab's bounded buffer, before filtering.",
  }),
  omittedCount: Schema.Int.annotate({
    description: "Retained matching entries omitted by the limit or shared byte budget.",
  }),
};
export const PreviewAutomationLogs = Schema.Struct({
  console: Schema.Struct({
    entries: Schema.Array(PreviewAutomationConsoleEntry),
    ...DiagnosticCounts,
  }),
  errors: Schema.Struct({ entries: Schema.Array(PreviewAutomationPageError), ...DiagnosticCounts }),
  network: Schema.Struct({
    entries: Schema.Array(PreviewAutomationNetworkEntry),
    ...DiagnosticCounts,
  }),
});
export type PreviewAutomationLogs = typeof PreviewAutomationLogs.Type;

export const PreviewAutomationRecordingStatus = Schema.Struct({
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
});
export type PreviewAutomationRecordingStatus = typeof PreviewAutomationRecordingStatus.Type;

export const PREVIEW_RECORDING_STOP_TIMEOUT_MS = 120_000;

export const PreviewAutomationRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: PreviewTabId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
});
export type PreviewAutomationRecordingArtifact = typeof PreviewAutomationRecordingArtifact.Type;

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationHostIdentity = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
});
export type PreviewAutomationHostIdentity = typeof PreviewAutomationHostIdentity.Type;

export const PreviewAutomationHost = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  /** Missing means the V1 operation set from before capability negotiation. */
  supportedOperations: Schema.optional(Schema.Array(PreviewAutomationOperation)),
  supportedFeatures: Schema.optional(Schema.Array(PreviewAutomationFeature)),
});
export type PreviewAutomationHost = typeof PreviewAutomationHost.Type;

export const PreviewAutomationHostFocus = Schema.Struct({
  ...PreviewAutomationHostIdentity.fields,
  connectionId: PreviewAutomationConnectionId,
  focused: Schema.Boolean,
  liveTabs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        tabId: PreviewTabId,
        visible: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type PreviewAutomationHostFocus = typeof PreviewAutomationHostFocus.Type;

export const PreviewAutomationRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
  tabIdExplicit: Schema.optional(Schema.Boolean),
  screenExpectation: Schema.optional(Screen.PreviewAutomationScreenExpectation),
  /** Supplied by the broker from authenticated scope, never from tool input. */
  agentSessionId: Schema.optional(Schema.String),
  operation: PreviewAutomationOperation,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequest.Type;

export const PreviewAutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: PreviewAutomationRequest,
  }),
]);
export type PreviewAutomationStreamEvent = typeof PreviewAutomationStreamEvent.Type;

export const PreviewAutomationResponse = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      _tag: TrimmedNonEmptyString,
      message: Schema.String,
      detail: Schema.optional(Schema.Unknown),
    }),
  ),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponse.Type;

const McpCapabilityErrorFields = {
  environmentId: EnvironmentId,
  threadId: Schema.optional(ThreadId),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
};

export class PreviewAutomationUnavailableError extends Schema.TaggedError<PreviewAutomationUnavailableError>()(
  "PreviewAutomationUnavailableError",
  {
    capability: Schema.Literal("preview"),
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability: browser preview tools are off for this thread. Do not retry them. Tell the person: they turn on "Agent browser access" in Settings for this host, and in this project's settings when the project overrides it; it applies when the agent session next starts. Whether this host's browser is installed says nothing about this thread's access.`;
  }
}

/** A `goat` MCP tool was called with a credential that does not carry its capability. */
export class McpCapabilityUnavailableError extends Schema.TaggedError<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: TrimmedNonEmptyString,
    ...McpCapabilityErrorFields,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}
const PreviewAutomationScopeErrorFields = {
  safety: Schema.optionalKey(ActionOutcomeSafety),
  /** A recovery step for a failure that another attempt can fix; absent when retrying cannot help. */
  next: Schema.optionalKey(Schema.String),
  operation: PreviewAutomationOperation,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: TrimmedNonEmptyString,
  providerInstanceId: ProviderInstanceId,
};

export const SERVER_BROWSER_AUTOMATION_CLIENT_ID = "server-browser";
const PreviewAutomationRequestErrorFields = {
  ...PreviewAutomationScopeErrorFields,
  clientId: TrimmedNonEmptyString,
  connectionId: PreviewAutomationConnectionId,
  requestId: TrimmedNonEmptyString,
  tabId: Schema.optional(PreviewTabId),
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  dispatched: Schema.optional(Schema.Boolean),
};

const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

export class PreviewAutomationNoAvailableHostError extends Schema.TaggedError<PreviewAutomationNoAvailableHostError>()(
  "PreviewAutomationNoAvailableHostError",
  {
    ...PreviewAutomationScopeErrorFields,
    clientId: Schema.optional(TrimmedNonEmptyString),
    connectionId: Schema.optional(PreviewAutomationConnectionId),
    requestId: Schema.optional(TrimmedNonEmptyString),
    tabId: Schema.optional(PreviewTabId),
    timeoutMs: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    if (this.operation === "read")
      return "This browser host cannot read pages; use goat_preview_snapshot.";
    return `No preview automation host is available for ${this.operation} in environment ${this.environmentId}. The server-owned browser may be starting or reconnecting. Retry goat_call {path:"preview.status"}, then call goat_call {path:"preview.open"} if no tab is available. If it remains unavailable, report the browser connection failure.`;
  }
}

export class PreviewAutomationUnsupportedClientError extends Schema.TaggedError<PreviewAutomationUnsupportedClientError>()(
  "PreviewAutomationUnsupportedClientError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} does not support ${this.operation}.`;
  }
}

/** The tab a caller named was a popup that closed: where its opener is, so the caller can go back. */
export const PreviewAutomationClosedPopup = Schema.Struct({
  openerTabId: TrimmedNonEmptyString,
  openerOpen: Schema.Boolean,
});
export type PreviewAutomationClosedPopup = typeof PreviewAutomationClosedPopup.Type;

export const closedPopupMessage = (tabId: string, popup: PreviewAutomationClosedPopup) =>
  popup.openerOpen
    ? `Tab ${tabId}, a popup, has closed. Its opener ${popup.openerTabId} is still open: pass tabId ${popup.openerTabId} to continue there.`
    : `Tab ${tabId}, a popup, has closed and its opener ${popup.openerTabId} is gone too. Choose a tab from goat_preview_status.`;

export class PreviewAutomationTabNotFoundError extends Schema.TaggedError<PreviewAutomationTabNotFoundError>()(
  "PreviewAutomationTabNotFoundError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    closedPopup: Schema.optional(PreviewAutomationClosedPopup),
  },
) {
  override get message(): string {
    if (this.tabId && this.closedPopup) return closedPopupMessage(this.tabId, this.closedPopup);
    return this.tabId
      ? `Preview tab ${this.tabId} was not found for ${this.operation}. Omit tabId to use the current tab, or call goat_call {path:"preview.open"}.`
      : `No active preview tab was found for ${this.operation}. Call goat_call {path:"preview.open"} first.`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedError<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationOptionalRemoteDiagnosticFields,
    interceptedBy: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
  },
) {
  override get message(): string {
    const summary = `Preview automation ${this.operation} timed out after ${this.timeoutMs}ms.`;
    return this.interceptedBy ? `${summary} ${this.interceptedBy}` : summary;
  }
}

export class PreviewAutomationControlInterruptedError extends Schema.TaggedError<PreviewAutomationControlInterruptedError>()(
  "PreviewAutomationControlInterruptedError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(PreviewAutomationControlReason),
  },
) {
  override get message(): string {
    return (
      previewControlMessage(this.reason) ??
      `Preview automation ${this.operation} was interrupted on client ${this.clientId}.`
    );
  }
}

export class PreviewAutomationExecutionError extends Schema.TaggedError<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    reason: Schema.optional(Schema.String),
    /** Why a secret fill could not use its secretRef: none to use, not for this page, or unreadable. */
    secretFailure: Schema.optional(
      Schema.Literals(["no_candidate", "not_permitted", "unavailable"]),
    ),
    unloadedTab: Schema.optional(Schema.Struct({ tabId: PreviewTabId, loadError: Schema.String })),
    /** Why a tab's fetch never got a response it could read: a CORS refusal, DNS, or the network. */
    fetchFailure: Schema.optional(Schema.Literals(["cors", "dns", "network"])),
  },
) {
  override get message(): string {
    return this.reason === undefined
      ? `Preview automation ${this.operation} failed on client ${this.clientId}.`
      : `Preview automation ${this.operation} failed: ${this.reason}`;
  }
}

export class PreviewAutomationInvalidSelectorError extends Schema.TaggedError<PreviewAutomationInvalidSelectorError>()(
  "PreviewAutomationInvalidSelectorError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    staleRef: Schema.optional(Schema.Boolean),
    matchCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(2))),
    /** The selector matched no element once the page had loaded. */
    noMatch: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    if (this.staleRef)
      return "This element ref is stale. Navigation, dialogs, and new snapshots replace refs; take a fresh snapshot and use its refs.";
    if (this.noMatch)
      return `Preview automation ${this.operation}: the selector matches no element, so nothing was sent. Take a fresh snapshot and use its refs, or wait for the element first.`;
    if (this.matchCount !== undefined)
      return `Preview automation ${this.operation}: the selector matches ${this.matchCount} elements; input needs one. Narrow it (text=..., a parent, ">> nth=0" for the first) or use a snapshot ref.`;
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} received an invalid ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} received an invalid selector.`;
  }
}

export class PreviewAutomationTargetNotEditableError extends Schema.TaggedError<PreviewAutomationTargetNotEditableError>()(
  "PreviewAutomationTargetNotEditableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    selectorKind: Schema.optional(Schema.Literals(["focused-element", "locator", "selector"])),
    selectorLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {
  override get message(): string {
    if (this.selectorKind === "focused-element") {
      return `Preview automation ${this.operation} requires an editable focused element.`;
    }
    if (this.selectorKind !== undefined && this.selectorLength !== undefined) {
      return `Preview automation ${this.operation} requires an editable ${this.selectorKind} (${this.selectorLength} characters).`;
    }
    return `Preview automation ${this.operation} requires an editable target.`;
  }
}

export class PreviewAutomationResultTooLargeError extends Schema.TaggedError<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
    maximumBytes: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  },
) {
  override get message(): string {
    const summary =
      this.maximumBytes === undefined
        ? `Preview automation ${this.operation} produced a result that is too large.`
        : `Preview automation ${this.operation} produced a result larger than ${this.maximumBytes} bytes.`;
    return summary;
  }
}

export class PreviewAutomationClientDisconnectedError extends Schema.TaggedError<PreviewAutomationClientDisconnectedError>()(
  "PreviewAutomationClientDisconnectedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} disconnected during ${this.operation}.`;
  }
}

export class PreviewAutomationRequestQueueClosedError extends Schema.TaggedError<PreviewAutomationRequestQueueClosedError>()(
  "PreviewAutomationRequestQueueClosedError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} stopped accepting ${this.operation} requests.`;
  }
}

export class PreviewAutomationRemoteUnavailableError extends Schema.TaggedError<PreviewAutomationRemoteUnavailableError>()(
  "PreviewAutomationRemoteUnavailableError",
  {
    ...PreviewAutomationRequestErrorFields,
    ...PreviewAutomationRemoteDiagnosticFields,
  },
) {
  override get message(): string {
    return `Preview automation ${this.operation} is unavailable on client ${this.clientId}.`;
  }
}

export class PreviewAutomationMalformedResponseError extends Schema.TaggedError<PreviewAutomationMalformedResponseError>()(
  "PreviewAutomationMalformedResponseError",
  PreviewAutomationRequestErrorFields,
) {
  override get message(): string {
    return `Preview automation client ${this.clientId} returned a malformed response for ${this.operation}.`;
  }
}

export class PreviewAutomationRecordingTransferError extends Schema.TaggedError<PreviewAutomationRecordingTransferError>()(
  "PreviewAutomationRecordingTransferError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Preview recording could not be saved to the agent environment.";
  }
}

export class PreviewAutomationRecordingDesktopUpdateRequiredError extends Schema.TaggedError<PreviewAutomationRecordingDesktopUpdateRequiredError>()(
  "PreviewAutomationRecordingDesktopUpdateRequiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Update the desktop app to transfer recordings. The recording remains on the desktop.";
  }
}

export class PreviewAutomationRecordingTooLargeError extends Schema.TaggedError<PreviewAutomationRecordingTooLargeError>()(
  "PreviewAutomationRecordingTooLargeError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording exceeds 50 MiB. Make a shorter recording.";
  }
}

export class PreviewAutomationRecordingDeadlineExpiredError extends Schema.TaggedError<PreviewAutomationRecordingDeadlineExpiredError>()(
  "PreviewAutomationRecordingDeadlineExpiredError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The recording transfer deadline expired.";
  }
}

export const PreviewAutomationError = Schema.Union([
  PreviewAutomationReadError,
  PreviewAutomationRecordingTransferError,
  PreviewAutomationRecordingDesktopUpdateRequiredError,
  PreviewAutomationRecordingTooLargeError,
  PreviewAutomationRecordingDeadlineExpiredError,
  PreviewAutomationUnavailableError,
  PreviewAutomationNoAvailableHostError,
  PreviewAutomationUnsupportedClientError,
  PreviewAutomationTabNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewAutomationControlInterruptedError,
  PreviewAutomationExecutionError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationClientDisconnectedError,
  PreviewAutomationRequestQueueClosedError,
  PreviewAutomationRemoteUnavailableError,
  PreviewAutomationMalformedResponseError,
]);
export type PreviewAutomationError = typeof PreviewAutomationError.Type;

export * from "./previewAutomationInputHold.ts";
export * from "./previewAutomationPrimitives.ts";
export * from "./previewAutomationSession.ts";
export * from "./previewUrlResolution.ts";
