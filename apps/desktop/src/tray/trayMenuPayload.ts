import * as Schema from "effect/Schema";

const TrayText = Schema.String.check(Schema.isMaxLength(1_000));
const TrayThreads = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    threadId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    title: TrayText,
    project: Schema.NullOr(TrayText),
  }),
).check(Schema.isMaxLength(20));

const COUNT_LIMIT = 1_000;
const TARGET_LIMIT = 13;
const ICON_LIMIT = 65_536;
const ThreadCount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COUNT_LIMIT }));
const AppCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: COUNT_LIMIT }));
const AppId = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024));
const PngIcon = Schema.String.check(
  Schema.isMaxLength(ICON_LIMIT),
  Schema.isPattern(/^data:image\/png;base64,/),
);

const TrayComputerUseTarget = Schema.Struct({
  appId: Schema.NullOr(AppId),
  name: TrayText,
  icon: Schema.NullOr(PngIcon),
  threadCount: ThreadCount,
});

const TrayComputerUse = Schema.Struct({
  threadCount: ThreadCount,
  appCount: AppCount,
  targets: Schema.Array(TrayComputerUseTarget).check(Schema.isMaxLength(TARGET_LIMIT)),
});

export const TrayMenuPayload = Schema.Struct({
  attention: TrayThreads,
  running: TrayThreads,
  pinned: TrayThreads,
  computerUse: Schema.optionalKey(Schema.NullOr(TrayComputerUse)),
});
