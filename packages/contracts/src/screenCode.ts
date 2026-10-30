import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ComputerUseRefusalReason } from "./computerUseProtocol.ts";

import { ActionOutcomeSafety } from "./actionOutcomeSafety.ts";

const id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const positive = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));
const finite = Schema.Number.check(Schema.makeFilter(Number.isFinite));

/**
 * A driver refusal's typed account, as the lease proxy names it (ComputerUseRefusalReason; detail
 * is a ComputerUseRefusalDetail, kept a string here because cua.ts already imports this module).
 */
const refusalFields = {
  refused: Schema.optionalKey(ComputerUseRefusalReason),
  detail: Schema.optionalKey(text(80)),
  /** The bundle id or app the refusal names, when the proxy knew it. */
  app: Schema.optionalKey(id),
  /** The thread holding the window or app, for target_busy and app_busy. */
  holderThreadId: Schema.optionalKey(id),
};
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const utf8Text = (max: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => new TextEncoder().encode(value).byteLength <= max),
  );
const boundedJson = (max: number) =>
  Schema.Json.check(Schema.makeFilter((value) => jsonBytes(value) <= max));

const strict = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      toCodecJson: () => undefined,
    },
  );

export const ScreenMethod = Schema.Literals([
  "list_apps",
  "list_windows",
  "bind_app",
  "get_window_state",
  "get_accessibility_tree",
  "verify_state",
  "screenshot",
  "click",
  "right_click",
  "hover",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "launch_app",
  "end_foreground",
  "list_tabs",
  "select_tab",
  "open_tab",
  "claim_tab",
  "keep_tab",
  "navigate_tab",
  "reload_tab",
  "back_tab",
  "forward_tab",
  "close_tab",
  "observe",
  "tab_status",
  "read_page",
  "select",
  "select_text",
  "wait_for",
  "invoke_menu",
  "fetch_tab",
  "list_menu_bar_extras",
]);
export type ScreenMethod = typeof ScreenMethod.Type;

export const ScreenRunLimits = Schema.Struct({
  sourceBytes: positive(64 * 1024),
  cellWallMs: positive(30_000),
  turnWasmBytes: positive(64 * 1024 * 1024),
  heapBytes: positive(16 * 1024 * 1024),
  stackBytes: positive(1024 * 1024),
  callsPerCell: positive(64),
  pendingCalls: positive(4),
  argBytes: positive(64 * 1024),
  returnBytes: positive(64 * 1024),
  consoleBytes: positive(16 * 1024),
  treeBytes: positive(128 * 1024),
  imageBytes: positive(2 * 1024 * 1024),
  journalEntries: positive(64),
  activeChildren: positive(4),
});
export type ScreenRunLimits = typeof ScreenRunLimits.Type;

/** GOAT's ceilings for one screen cell; a request may lower them, never raise them. */
export const DEFAULT_SCREEN_RUN_LIMITS: ScreenRunLimits = {
  sourceBytes: 64 * 1024,
  cellWallMs: 30_000,
  turnWasmBytes: 64 * 1024 * 1024,
  heapBytes: 16 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  callsPerCell: 64,
  pendingCalls: 4,
  argBytes: 64 * 1024,
  returnBytes: 64 * 1024,
  consoleBytes: 16 * 1024,
  treeBytes: 128 * 1024,
  imageBytes: 2 * 1024 * 1024,
  journalEntries: 64,
  activeChildren: 4,
};

export const ScreenRunBoot = Schema.Struct({
  t: Schema.Literal("boot"),
  limits: ScreenRunLimits,
  wasmPath: text(4096),
  wasmSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ScreenRunBoot = typeof ScreenRunBoot.Type;

/** A child serves one thread across its turns, so each cell names the run and turn it acts for. */
export const ScreenRunCell = Schema.Struct({
  t: Schema.Literal("cell"),
  runId: id,
  turnId: id,
  cellId: id,
  source: utf8Text(64 * 1024),
  resetValues: Schema.Boolean,
  limits: ScreenRunLimits,
  /** The parent's epoch-ms wall deadline, so time spent starting the child counts on both sides. */
  deadlineMillis: natural,
});
export type ScreenRunCell = typeof ScreenRunCell.Type;

export const ScreenTargetRef = Schema.Struct({
  id,
  kind: Schema.Literals(["app", "tab"]),
  environmentId: id,
  runId: id,
  turnId: id,
  generation: natural,
});
export type ScreenTargetRef = typeof ScreenTargetRef.Type;

export const ScreenElementRef = Schema.Struct({
  id,
  targetId: id,
  observationId: id,
  surfaceGeneration: natural,
});
export type ScreenElementRef = typeof ScreenElementRef.Type;

export const ScreenPointRef = Schema.Struct({
  observationId: id,
  regionId: id,
  x: finite,
  y: finite,
});
export type ScreenPointRef = typeof ScreenPointRef.Type;

const imageRegion = Schema.Struct({
  kind: Schema.Literals(["window", "viewport", "document", "element"]),
  x: finite,
  y: finite,
  width: positive(Number.MAX_SAFE_INTEGER),
  height: positive(Number.MAX_SAFE_INTEGER),
});
const imageFields = {
  imageRef: id,
  callId: natural,
  targetId: id,
  observationId: id,
  regionId: id,
  region: imageRegion,
  pixelWidth: positive(Number.MAX_SAFE_INTEGER),
  pixelHeight: positive(Number.MAX_SAFE_INTEGER),
  scale: Schema.Number.check(Schema.makeFilter((value) => Number.isFinite(value) && value > 0)),
  /** Raw display backing scale (e.g. 2 on Retina), when the delivered image was downscaled. */
  backingScale: Schema.optionalKey(
    Schema.Number.check(Schema.makeFilter((value) => Number.isFinite(value) && value > 0)),
  ),
  /** Window points per image pixel (region.width / pixelWidth, region.height / pixelHeight). */
  pointsPerPixel: Schema.optionalKey(
    Schema.Struct({
      x: Schema.Number.check(Schema.makeFilter((value) => Number.isFinite(value) && value > 0)),
      y: Schema.Number.check(Schema.makeFilter((value) => Number.isFinite(value) && value > 0)),
    }),
  ),
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
};
export const ScreenImageMetadata = Schema.Struct({
  ...imageFields,
  omitted: Schema.optionalKey(Schema.Boolean),
});
export type ScreenImageMetadata = typeof ScreenImageMetadata.Type;

const base64 = Schema.String.check(
  Schema.isMaxLength(Math.ceil((2 * 1024 * 1024) / 3) * 4),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  Schema.makeFilter(
    (value) =>
      (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <=
      2 * 1024 * 1024,
  ),
);
export const ScreenImage = Schema.Struct({ ...imageFields, bytes: base64 });
export type ScreenImage = typeof ScreenImage.Type;

/**
 * Where one driver call spent its time, in ms: the proxy's queueMs, admitMs (to the line reaching
 * the driver), driverMs and replyMs, and channelMs, what the host measured beyond them.
 */
export const proxyHopFields = {
  queueMs: Schema.optionalKey(natural),
  admitMs: Schema.optionalKey(natural),
  driverMs: Schema.optionalKey(natural),
  replyMs: Schema.optionalKey(natural),
};
export const ScreenHopTimes = Schema.Struct({
  ...proxyHopFields,
  channelMs: Schema.optionalKey(natural),
});
export type ScreenHopTimes = typeof ScreenHopTimes.Type;

/** Host time of one read by step: driver calls, tree parsing, rendering, and the rest of the host. */
export const ScreenReadPhases = Schema.Struct({
  driverMs: natural,
  parseMs: natural,
  renderMs: natural,
  bridgeMs: natural,
  hops: Schema.optionalKey(ScreenHopTimes),
});
export type ScreenReadPhases = typeof ScreenReadPhases.Type;

export const ScreenObservation = Schema.Struct({
  observationId: id,
  snapshot: Schema.optionalKey(id),
  targetRef: ScreenTargetRef,
  targetGeneration: natural,
  surfaceGeneration: natural,
  mode: Schema.Literals(["full", "diff", "query"]),
  baseObservationId: Schema.optionalKey(id),
  complete: Schema.Boolean,
  truncated: Schema.Boolean,
  loading: Schema.Boolean,
  title: Schema.optionalKey(text(1024)),
  url: Schema.optionalKey(text(8192)),
  indexedText: utf8Text(128 * 1024),
  elements: Schema.Array(
    Schema.Struct({
      index: natural,
      role: text(200),
      name: text(1024),
      text: Schema.optionalKey(text(4096)),
      /** What the element offers and its state, as the desktop driver reports them. */
      actions: Schema.optionalKey(Schema.Array(text(80)).check(Schema.isMaxLength(16))),
      enabled: Schema.optionalKey(Schema.Boolean),
      selected: Schema.optionalKey(Schema.Boolean),
      /** The app's keyboard focus is on this element. */
      focused: Schema.optionalKey(Schema.Boolean),
      /** An editable field's selected text, "" for a caret, and its range in UTF-16 code units. */
      selectedText: Schema.optionalKey(text(4096)),
      selectedTextRange: Schema.optionalKey(Schema.Struct({ location: natural, length: natural })),
      /** The value as the app words it, such as "8 dB" for a slider at 8. */
      valueDescription: Schema.optionalKey(text(1024)),
      /** The file or web address the element names. */
      url: Schema.optionalKey(text(8192)),
      frame: Schema.optionalKey(
        Schema.Struct({ x: finite, y: finite, width: finite, height: finite }),
      ),
      range: Schema.optionalKey(Schema.Struct({ min: finite, max: finite })),
      /** The index of the element that contains this one, in the same observation. */
      parent: Schema.optionalKey(natural),
      /** The element's accessibility identifier, when the app sets one; stable across languages. */
      id: Schema.optionalKey(text(400)),
      ref: ScreenElementRef,
    }),
  ).check(Schema.isMaxLength(4096)),
  image: Schema.optionalKey(ScreenImageMetadata),
  resetReason: Schema.optionalKey(text(200)),
  /** What the observation covered: the whole window or page, interactive controls, or a scope. */
  scope: Schema.optionalKey(text(1024)),
  /** Regions the observation could not include, so absence there proves nothing. */
  omitted: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["frames", "virtualized", "pixels", "budget"]),
        detail: Schema.optionalKey(text(200)),
      }),
    ).check(Schema.isMaxLength(16)),
  ),
  incompleteSearch: Schema.optionalKey(Schema.Boolean),
  /** Host time of this read in total and by step; left out when it would not fit the reply. */
  ms: Schema.optionalKey(natural),
  phases: Schema.optionalKey(ScreenReadPhases),
}).check(Schema.makeFilter((value) => jsonBytes(value) <= 128 * 1024));
export type ScreenObservation = typeof ScreenObservation.Type;

export type ScreenModelObservation = Omit<ScreenObservation, "elements" | "indexedText"> & {
  readonly text: string;
};

const ScreenOutcomeStatus = Schema.Literals(["confirmed", "refused", "failed", "unknown"]);

/**
 * An action's result on two axes: whether the input went out, and whether the page visibly
 * changed. Whether the task's state was reached is the caller's verify, on its own budget.
 */
export const ScreenActionOutcome = Schema.Struct({
  dispatch: ScreenOutcomeStatus,
  effect: ScreenOutcomeStatus,
});
export type ScreenActionOutcome = typeof ScreenActionOutcome.Type;

export const ScreenEffectReceipt = Schema.Struct({
  safety: Schema.optionalKey(ActionOutcomeSafety),
  callId: natural,
  targetId: Schema.optionalKey(id),
  method: ScreenMethod,
  journalState: Schema.Literals(["admitted", "dispatched", "settled", "unknown"]),
  category: Schema.Literals([
    "confirmed",
    "partial",
    "unverifiable",
    "suspected_noop",
    "refused",
    "unknown_outcome",
  ]),
  dispatched: Schema.Boolean,
  evidence: Schema.Array(text(200)).check(Schema.isMaxLength(16)),
  outcome: Schema.optionalKey(ScreenActionOutcome),
  ...refusalFields,
});
export type ScreenEffectReceipt = typeof ScreenEffectReceipt.Type;

export const ScreenWindowSummary = Schema.Struct({
  window_id: natural,
  title: text(80),
  width: Schema.optionalKey(finite),
  height: Schema.optionalKey(finite),
  sheetOf: Schema.optionalKey(natural),
});
export type ScreenWindowSummary = typeof ScreenWindowSummary.Type;

const cellWindowFields = {
  /** Windows listed as newly opened for the apps this cell sent input to; never a completeness claim. */
  windowsOpened: Schema.optionalKey(
    Schema.Array(ScreenWindowSummary).check(Schema.isMaxLength(16)),
  ),
  windowsOpenedTruncated: Schema.optionalKey(Schema.Boolean),
  windowsOpenedUnverified: Schema.optionalKey(Schema.Boolean),
};

export const ScreenRunError = Schema.Struct({
  safety: Schema.optionalKey(ActionOutcomeSafety),
  code: Schema.Literals([
    "invalid_argument",
    "unsupported",
    "unavailable",
    "target_missing",
    "target_ambiguous",
    "stale_reference",
    "permission_denied",
    "user_intervened",
    "stopped",
    "deadline",
    "resource_exhausted",
    "runtime_unavailable",
    "downstream_failure",
    "unknown_outcome",
    "source_limit",
    "wall_limit",
    "call_limit",
    "pending_limit",
    "output_limit",
    "text_limit",
    "tree_limit",
    "image_limit",
    "live_children_limit",
    "stale_run",
    "stale_target",
    "paused",
    "private",
    "cleanup_failed",
    "context_reset",
    // An earlier call in the same cell failed, so this one was never dispatched.
    "not_run",
  ]),
  reason: Schema.optionalKey(Schema.Literal("desktop_not_ready")),
  ...refusalFields,
  callId: Schema.optionalKey(natural),
  targetId: Schema.optionalKey(id),
  /** The cell that failed, as a result names its cell. */
  cellId: Schema.optionalKey(id),
  effectStarted: Schema.Boolean,
  lastObservationId: Schema.optionalKey(id),
  limit: Schema.optionalKey(Schema.Struct({ name: text(80), maximum: natural })),
  receipts: Schema.optionalKey(Schema.Array(ScreenEffectReceipt).check(Schema.isMaxLength(16))),
  nextStep: text(1024),
  message: Schema.optionalKey(text(200)),
  /** What the driver said of the call, such as its effect and code, for the call's receipt. */
  evidence: Schema.optionalKey(Schema.Array(text(200)).check(Schema.isMaxLength(16))),
  ...cellWindowFields,
});
export type ScreenRunError = typeof ScreenRunError.Type;

export const ScreenGuestError = Schema.Struct({
  name: text(80),
  message: utf8Text(1024),
  safety: Schema.optionalKey(ActionOutcomeSafety),
});
export type ScreenGuestError = typeof ScreenGuestError.Type;

export const ScreenHostCall = strict(
  Schema.Struct({
    t: Schema.Literal("call"),
    runId: id,
    turnId: id,
    cellId: id,
    callId: natural,
    targetRef: Schema.optionalKey(ScreenTargetRef),
    method: ScreenMethod,
    args: boundedJson(64 * 1024),
    deadlineMillis: natural,
  }),
);
export type ScreenHostCall = typeof ScreenHostCall.Type;

export const ScreenHostReply = strict(
  Schema.Struct({
    t: Schema.Literal("reply"),
    runId: id,
    cellId: id,
    callId: natural,
    outcome: Schema.Literals(["ok", "error"]),
    value: Schema.optionalKey(boundedJson(64 * 1024)),
    error: Schema.optionalKey(ScreenRunError),
    /** The call's receipt category, so a Target method can report what the host confirmed. */
    category: Schema.optionalKey(ScreenEffectReceipt.fields.category),
  }),
);
export type ScreenHostReply = typeof ScreenHostReply.Type;

export const ScreenJournalEntry = Schema.Struct({
  sequence: natural,
  receipt: ScreenEffectReceipt,
  truncated: Schema.Boolean,
});
export type ScreenJournalEntry = typeof ScreenJournalEntry.Type;

export const ScreenSurfaceAvailability = Schema.Struct({
  kind: Schema.Literals(["app", "tab"]),
  available: Schema.Boolean,
  reason: Schema.optionalKey(
    Schema.Literals(["no_lease", "paused", "private", "helper_unavailable", "no_host"]),
  ),
});
export type ScreenSurfaceAvailability = typeof ScreenSurfaceAvailability.Type;

/**
 * Longest cell API bundle a result carries. It is sent once per thread and is about 8 KiB with
 * both surfaces; twice that leaves room to grow, and result.test.ts fails once a bundle outgrows it.
 */
const SCREEN_TARGET_API_MAX_CHARS = 16 * 1024;

export const ScreenRunResult = Schema.Struct({
  runId: id,
  turnId: id,
  cellId: id,
  status: Schema.Literals(["completed", "failed", "stopped", "deadline", "resource_exhausted"]),
  error: Schema.optionalKey(Schema.Union([ScreenRunError, ScreenGuestError])),
  value: Schema.optionalKey(boundedJson(64 * 1024)),
  console: Schema.Array(utf8Text(16 * 1024)).check(Schema.isMaxLength(64)),
  journal: Schema.Array(ScreenJournalEntry).check(Schema.isMaxLength(64)),
  truncated: Schema.Array(text(200)).check(Schema.isMaxLength(64)),
  availability: Schema.Array(ScreenSurfaceAvailability).check(Schema.isMaxLength(2)),
  imageMetadata: Schema.Array(ScreenImageMetadata).check(Schema.isMaxLength(64)),
  images: Schema.Array(ScreenImage).check(Schema.isMaxLength(64)),
  /** The cell API bundle (screenTargetApi), when this thread needs it again. */
  api: Schema.optionalKey(text(SCREEN_TARGET_API_MAX_CHARS)),
  /** SCREEN_TARGET_CONTRACT_VERSION, on every result, so a stale copy of the API is noticed. */
  contractVersion: Schema.optionalKey(text(40)),
  ...cellWindowFields,
}).check(
  Schema.makeFilter(
    (value) =>
      value.console.reduce((total, line) => total + new TextEncoder().encode(line).byteLength, 0) <=
        16 * 1024 &&
      value.images.reduce(
        (total, image) =>
          total +
          (image.bytes.length / 4) * 3 -
          (image.bytes.endsWith("==") ? 2 : image.bytes.endsWith("=") ? 1 : 0),
        0,
      ) <=
        2 * 1024 * 1024,
  ),
);
export type ScreenRunResult = typeof ScreenRunResult.Type;
/** Trusted turn input; it is never serialized into the guest protocol. */
export type ScreenBindingHints = {
  browserRequested: boolean;
  computerRequested: boolean;
  appIds: readonly string[];
  tabs: readonly {
    mentionId: string;
    environmentId: string;
    browserInstanceId: string;
    tabId: string;
    titleAtMention: string;
    urlAtMention: string;
  }[];
};
