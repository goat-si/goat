import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

const id = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const positive = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));
const finite = Schema.Number.check(Schema.makeFilter(Number.isFinite));
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
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "set_value",
  "bring_to_front",
  "launch_app",
  "end_foreground",
  "list_tabs",
  "bind_tab",
  "open_tab",
  "claim_tab",
  "keep_tab",
  "navigate_tab",
  "reload_tab",
  "back_tab",
  "forward_tab",
  "close_tab",
  "observe",
  "select",
  "select_text",
  "wait_for",
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
  runId: id,
  turnId: id,
  limits: ScreenRunLimits,
  wasmPath: text(4096),
  wasmSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type ScreenRunBoot = typeof ScreenRunBoot.Type;

export const ScreenRunCell = Schema.Struct({
  t: Schema.Literal("cell"),
  cellId: id,
  source: utf8Text(64 * 1024),
  resetValues: Schema.Boolean,
  limits: ScreenRunLimits,
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

export const ScreenObservation = Schema.Struct({
  observationId: id,
  targetRef: ScreenTargetRef,
  targetGeneration: natural,
  surfaceGeneration: natural,
  mode: Schema.Literals(["full", "diff", "query"]),
  baseObservationId: Schema.optionalKey(id),
  complete: Schema.Boolean,
  truncated: Schema.Boolean,
  loading: Schema.Boolean,
  indexedText: utf8Text(128 * 1024),
  elements: Schema.Array(
    Schema.Struct({
      index: natural,
      role: text(200),
      name: text(1024),
      text: Schema.optionalKey(text(4096)),
      ref: ScreenElementRef,
    }),
  ).check(Schema.isMaxLength(4096)),
  image: Schema.optionalKey(ScreenImageMetadata),
  resetReason: Schema.optionalKey(text(200)),
  incompleteSearch: Schema.optionalKey(Schema.Boolean),
}).check(Schema.makeFilter((value) => jsonBytes(value) <= 128 * 1024));
export type ScreenObservation = typeof ScreenObservation.Type;

export const ScreenEffectReceipt = Schema.Struct({
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
});
export type ScreenEffectReceipt = typeof ScreenEffectReceipt.Type;

export const ScreenRunError = Schema.Struct({
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
  ]),
  reason: Schema.optionalKey(Schema.Literal("desktop_not_ready")),
  callId: Schema.optionalKey(natural),
  targetId: Schema.optionalKey(id),
  effectStarted: Schema.Boolean,
  lastObservationId: Schema.optionalKey(id),
  limit: Schema.optionalKey(Schema.Struct({ name: text(80), maximum: natural })),
  receipts: Schema.optionalKey(Schema.Array(ScreenEffectReceipt).check(Schema.isMaxLength(16))),
  nextStep: text(1024),
});
export type ScreenRunError = typeof ScreenRunError.Type;

export const ScreenGuestError = Schema.Struct({
  name: text(80),
  message: utf8Text(1024),
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
