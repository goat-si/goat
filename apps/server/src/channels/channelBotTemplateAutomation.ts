import {
  ChannelGatewayError,
  CommandId,
  type BotProfile,
  type ModelSelection,
  type ProjectId,
} from "@goat/contracts";
import type { goatBotTemplate } from "@goat/shared/goatBotNames";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type {
  CapturedTaskMemoryGrant,
  ScheduledTaskService,
} from "../scheduledTasks/ScheduledTaskService.ts";

type Template = NonNullable<ReturnType<typeof goatBotTemplate>>;

export interface TemplateCreation {
  readonly service: ScheduledTaskService["Service"];
  readonly capture: Effect.Effect<CapturedTaskMemoryGrant, unknown>;
}

export const templateAuthority = Effect.fn("ChannelBotTemplates.authority")(function* (
  creation: TemplateCreation | undefined,
) {
  const denied = new ChannelGatewayError({ reason: "forbidden" });
  if (creation === undefined) return yield* denied;
  const grant = yield* creation.capture.pipe(Effect.mapError(() => denied));
  const owner = grant.owner;
  if (
    owner?.sessionId === undefined ||
    !owner.grantedScopes.includes("settings:write") ||
    !owner.grantedScopes.includes("orchestration:operate")
  )
    return yield* denied;
  return { service: creation.service, grant, principalId: owner.principalId };
});

export const addTemplateAutomation = Effect.fn("ChannelBotTemplates.addAutomation")(function* (
  sql: SqlClient.SqlClient,
  authority: Effect.Success<ReturnType<typeof templateAuthority>>,
  template: Template,
  bot: BotProfile,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  receiptKey: string,
) {
  const commandId = CommandId.make(`bot-template:${bot.sessionThreadId}`);
  const rows =
    yield* sql`SELECT 1 FROM scheduled_tasks WHERE task_id = ${"scheduled-task:" + commandId}`;
  if (rows.length === 0) {
    const result = yield* authority.service
      .upsert(
        {
          ...template.automation,
          ...(template.automation.schedule.type === "webhook" ? { routineMode: "work" } : {}),
          commandId,
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
        authority.grant,
      )
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Could not add paused bot template automation", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (!result) return false;
  }
  yield* sql`UPDATE channel_runtime_state
    SET value_json = json_set(value_json, '$.automationAdded', json('true'))
    WHERE key = ${receiptKey}`;
  return true;
});
