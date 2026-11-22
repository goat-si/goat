import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BotColor, BotId, BotInstructions, BotProfile, BotToolNames } from "./botProfile.ts";
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskFixedTimeSchedule,
  ScheduledTaskWebhookDedupe,
  ScheduledTaskWebhookFilters,
  WebhookMaxDeliveryAgeMinutes,
} from "./scheduledTask.ts";

export const BOT_PACKAGE_EXTENSION = ".goatbot.json";
export function botPackageFileName(name: string): string {
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (stem || "bot") + BOT_PACKAGE_EXTENSION;
}
export const BOT_PACKAGE_MAX_BYTES = 64 * 1024;
export const BOT_PACKAGE_MAX_AUTOMATIONS = 24;
const MAX_DROPPED_FIELDS = 128;
const encoder = new TextEncoder();
const BotPackageText = Schema.String.check(
  Schema.isMaxLength(BOT_PACKAGE_MAX_BYTES),
  Schema.makeFilter((value) => encoder.encode(value).byteLength <= BOT_PACKAGE_MAX_BYTES),
);
const PackageSignature = Schema.Struct({
  header: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/)),
  encoding: Schema.Literals(["hex", "base64"]),
  prefix: Schema.String.check(Schema.isMaxLength(128)),
});
const PackageWebhook = Schema.Struct({
  type: Schema.Literal("webhook"),
  signature: PackageSignature,
  maxDeliveryAgeMinutes: Schema.optional(Schema.NullOr(WebhookMaxDeliveryAgeMinutes)),
  dedupe: Schema.optional(ScheduledTaskWebhookDedupe),
  filters: Schema.optional(ScheduledTaskWebhookFilters),
  allowChecksWithoutPullRequest: Schema.optional(Schema.Boolean),
});
const Automation = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(16 * 1024)),
  schedule: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("interval"),
      everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_SCHEDULED_TASK_INTERVAL_MS)),
    }),
    ScheduledTaskFixedTimeSchedule,
    PackageWebhook,
  ]),
});
const BotPackage = Schema.Struct({
  version: Schema.Literal(1),
  name: BotProfile.fields.name,
  face: BotProfile.fields.avatar,
  color: Schema.NullOr(BotColor),
  purpose: BotProfile.fields.purpose,
  instructions: BotInstructions,
  automations: Schema.Array(Automation).check(Schema.isMaxLength(BOT_PACKAGE_MAX_AUTOMATIONS)),
  tools: BotToolNames,
});
export type BotPackage = typeof BotPackage.Type;

const decode = Schema.decodeUnknownSync(BotPackage);
const isText = Schema.is(BotPackageText);
const pointer = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const dropUnknown = (raw: unknown, clean: unknown, path: string, dropped: string[]): void => {
  if (raw === null || typeof raw !== "object" || clean === null || typeof clean !== "object")
    return;
  for (const [key, value] of Object.entries(raw)) {
    const field = path + "/" + pointer(key);
    if (!Object.hasOwn(clean, key)) {
      if (dropped.length >= MAX_DROPPED_FIELDS || field.length > 512)
        throw new Error("Too many or too long unknown field names.");
      dropped.push(field);
    } else {
      dropUnknown(value, Object.getOwnPropertyDescriptor(clean, key)?.value, field, dropped);
    }
  }
};

export function decodeBotPackage(text: string): {
  readonly botPackage: BotPackage;
  readonly droppedFields: readonly string[];
} {
  if (!isText(text)) throw new Error("Bot package exceeds the 64 KB size limit.");
  const raw: unknown = JSON.parse(text);
  const botPackage = decode(raw);
  const droppedFields: string[] = [];
  dropUnknown(raw, botPackage, "", droppedFields);
  return { botPackage, droppedFields: droppedFields.sort() };
}

export const BotPackageExportInput = Schema.Struct({ botId: BotId });
export type BotPackageExportInput = typeof BotPackageExportInput.Type;
export const BotPackageExportResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), contents: BotPackageText }),
  Schema.Struct({ status: Schema.Literal("blocked"), fields: Schema.Array(Schema.String) }),
]);
export type BotPackageExportResult = typeof BotPackageExportResult.Type;
export const BotPackageReviewInput = Schema.Struct({ text: BotPackageText });
export type BotPackageReviewInput = typeof BotPackageReviewInput.Type;
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const BotPackageReviewResult = Schema.Struct({
  botPackage: BotPackage,
  droppedFields: Schema.Array(Schema.String),
  digest: Digest,
});
export type BotPackageReviewResult = typeof BotPackageReviewResult.Type;
export const BotPackageImportInput = Schema.Struct({
  ...BotPackageReviewInput.fields,
  digest: Digest,
  clientRequestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type BotPackageImportInput = typeof BotPackageImportInput.Type;
export const BotPackageImportResult = Schema.Struct({ bot: BotProfile });
