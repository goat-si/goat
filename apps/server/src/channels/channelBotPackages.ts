// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 binds confirmation to the reviewed file bytes.
import * as NodeCrypto from "node:crypto";
import {
  BOT_PACKAGE_MAX_AUTOMATIONS,
  BOT_PACKAGE_MAX_BYTES,
  ChannelGatewayError,
  CommandId,
  ScheduledTask,
  decodeBotPackage,
  type BotPackage,
  type BotPackageExportResult,
  type BotPackageReviewInput,
  type BotProfile,
  type ModelSelection,
  type ProjectId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { templateAuthority } from "./channelBotTemplateAutomation.ts";

const invalidPackage = () => new ChannelGatewayError({ reason: "bot_package_invalid" });
const persistenceFailed = () => new ChannelGatewayError({ reason: "persistence_failed" });

export const reviewBotPackage = Effect.fn("ChannelBotPackages.review")(function* ({
  text,
}: BotPackageReviewInput) {
  const decoded = yield* Effect.try({ try: () => decodeBotPackage(text), catch: invalidPackage });
  const digest = NodeCrypto.createHash("sha256").update(text).digest("hex");
  return { ...decoded, digest };
});

const KNOWN_SECRET =
  /(?:\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|hooks\.slack\.com\/services\/|\/api\/hooks\/|\bBearer\s+[A-Za-z0-9._~+/=-]{16,})/i;

function looksLikeSecret(text: string): boolean {
  if (KNOWN_SECRET.test(text)) return true;
  for (const [candidate] of text.matchAll(/[A-Za-z0-9_+/=-]{24,}/g)) {
    const counts = new Map<string, number>();
    for (const character of candidate) counts.set(character, (counts.get(character) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
      const frequency = count / candidate.length;
      entropy -= frequency * Math.log2(frequency);
    }
    if (
      entropy >= 4 ||
      (candidate.length >= 32 && /^[0-9a-f]+$/i.test(candidate) && entropy >= 3.3)
    )
      return true;
  }
  return false;
}

function secretFields(value: unknown, path = ""): readonly string[] {
  if (typeof value === "string") return looksLikeSecret(value) ? [path] : [];
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => secretFields(entry, path + "/" + key));
}

const decodeSchedule = Schema.decodeUnknownSync(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);

function portableSchedule(raw: string) {
  const schedule = decodeSchedule(raw);
  if (schedule.type !== "webhook") return schedule;
  const { signature, ...fields } = schedule;
  if (signature === null) throw new Error("A bot trigger must use a signature.");
  const { header, encoding, prefix } = signature;
  return { ...fields, signature: { header, encoding, prefix } };
}

export const exportBotPackage = Effect.fn("ChannelBotPackages.export")(function* (
  sql: SqlClient.SqlClient,
  bot: BotProfile,
): Effect.fn.Return<BotPackageExportResult, ChannelGatewayError> {
  const rows = yield* sql<{
    readonly title: string | null;
    readonly prompt: string | null;
    readonly schedule_json: string | null;
  }>`
    SELECT
      CASE WHEN length(CAST(title AS BLOB)) <= ${BOT_PACKAGE_MAX_BYTES} THEN title END AS title,
      CASE WHEN length(CAST(prompt AS BLOB)) <= ${BOT_PACKAGE_MAX_BYTES} THEN prompt END AS prompt,
      CASE WHEN length(CAST(schedule_json AS BLOB)) <= ${BOT_PACKAGE_MAX_BYTES} THEN schedule_json END AS schedule_json
    FROM scheduled_tasks WHERE thread_id = ${bot.sessionThreadId} AND owner_json IS NOT NULL
    ORDER BY created_at, task_id LIMIT ${BOT_PACKAGE_MAX_AUTOMATIONS + 1}
  `.pipe(Effect.mapError(persistenceFailed));

  const packageResult = yield* Effect.try({
    try: () => {
      if (rows.length > BOT_PACKAGE_MAX_AUTOMATIONS)
        throw new Error("Too many automations to export.");
      const automations = rows.map((row) => {
        if (row.title === null || row.prompt === null || row.schedule_json === null)
          throw new Error("Automation exceeds the size limit.");
        return {
          title: row.title,
          prompt: row.prompt,
          schedule: portableSchedule(row.schedule_json),
        };
      });
      const names = (key: "mcpServers" | "skills") => {
        const local = bot.tools?.[key];
        return [
          ...new Set([
            ...(bot.importedToolNames?.[key] ?? []),
            ...(Array.isArray(local) ? local : []),
          ]),
        ];
      };
      const { botPackage } = decodeBotPackage(
        JSON.stringify({
          version: 1,
          name: bot.name,
          face: bot.avatar,
          color: bot.color ?? null,
          purpose: bot.purpose,
          instructions: bot.instructions ?? "",
          automations,
          tools: { mcpServers: names("mcpServers"), skills: names("skills") },
        }),
      );
      const fields = secretFields(botPackage);
      if (fields.length > 0) return { status: "blocked", fields } as const;
      const contents = JSON.stringify(botPackage, null, 2) + "\n";
      if (Buffer.byteLength(contents) > BOT_PACKAGE_MAX_BYTES)
        return { status: "ready", contents: JSON.stringify(botPackage) } as const;
      return { status: "ready", contents } as const;
    },
    catch: invalidPackage,
  });
  return packageResult;
});

export const addImportedAutomations = Effect.fn("ChannelBotPackages.addAutomations")(function* (
  sql: SqlClient.SqlClient,
  authority: Effect.Success<ReturnType<typeof templateAuthority>>,
  botPackage: BotPackage,
  bot: BotProfile,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  receiptKey: string,
) {
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        for (const [index, automation] of botPackage.automations.entries()) {
          yield* authority.service.upsert(
            {
              ...automation,
              ...(automation.schedule.type === "webhook" ? { routineMode: "work" } : {}),
              commandId: CommandId.make(`bot-import:${bot.sessionThreadId}:${index}`),
              enabled: false,
              projectId,
              threadId: bot.sessionThreadId,
              workspaceStrategy: { type: "root" },
              modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdBy: "user",
              creationSource: "server",
            },
            { ...authority.grant, memoryGrantCeiling: "none" },
          );
        }
        yield* sql`UPDATE channel_runtime_state
          SET value_json = json_set(value_json, '$.automationAdded', json('true'))
          WHERE key = ${receiptKey}`;
      }),
    )
    .pipe(Effect.mapError(persistenceFailed));
});
