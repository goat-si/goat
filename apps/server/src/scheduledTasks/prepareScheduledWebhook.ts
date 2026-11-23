import type {
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskError,
  ScheduledTaskUpsertInput,
  ScheduledTaskWebhookFilter,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { taskError } from "./scheduledTaskError.ts";

const webhookFilters = (filters: ReadonlyArray<ScheduledTaskWebhookFilter> | undefined) =>
  filters?.length ? { filters } : {};

export const prepareScheduledWebhook = Effect.fn("ScheduledTaskService.prepareWebhook")(
  function* (options: {
    readonly input: ScheduledTaskUpsertInput;
    readonly existingTask: ScheduledTask | null;
    readonly id: ScheduledTaskId;
    readonly work: boolean;
    readonly findWebhookCredentials: Effect.Effect<
      { readonly token: string | null; readonly secret: string | null } | null,
      ScheduledTaskError
    >;
    readonly newWebhookToken: Effect.Effect<string, ScheduledTaskError>;
  }) {
    const { input, existingTask, id, work, findWebhookCredentials, newWebhookToken } = options;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const schedule: ScheduledTask["schedule"] =
      input.schedule.type === "webhook"
        ? {
            type: "webhook",
            signature:
              input.schedule.signature == null
                ? null
                : {
                    header: input.schedule.signature.header.toLowerCase(),
                    encoding: input.schedule.signature.encoding,
                    prefix: input.schedule.signature.prefix,
                    ...(work ? { required: true as const } : {}),
                  },
            ...((input.schedule.allowChecksWithoutPullRequest ??
              (existingTask?.schedule.type === "webhook"
                ? existingTask.schedule.allowChecksWithoutPullRequest
                : undefined)) === true
              ? { allowChecksWithoutPullRequest: true }
              : {}),
            maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
            ...(input.schedule.dedupe === undefined
              ? existingTask?.schedule.type === "webhook" &&
                existingTask.schedule.dedupe !== undefined
                ? { dedupe: existingTask.schedule.dedupe }
                : {}
              : { dedupe: input.schedule.dedupe }),
            ...webhookFilters(
              // Omitted keeps the stored filters, so a client that predates
              // them can re-save a task without clearing them.
              input.schedule.filters ??
                (existingTask?.schedule.type === "webhook"
                  ? existingTask.schedule.filters
                  : undefined),
            ),
          }
        : input.schedule;
    const webhook =
      input.schedule.type === "webhook"
        ? yield* Effect.gen(function* () {
            const existing = existingTask === null ? null : yield* findWebhookCredentials;
            const token = existing?.token ?? (yield* newWebhookToken);
            const signature = input.schedule.type === "webhook" ? input.schedule.signature : null;
            // A secretRef is a value the user entered for an agent; this
            // save consumes it, so it cannot be used again. A replay of a
            // save that already used it keeps the secret that save stored.
            const replay = input.commandId !== undefined && existing?.secret != null;
            const fromRef =
              signature?.secretRef === undefined
                ? undefined
                : yield* secretRequests
                    .consume({ ref: signature.secretRef, projectId: input.projectId })
                    .pipe(
                      Effect.catch((error) =>
                        replay
                          ? Effect.void
                          : Effect.fail(taskError(error.message, { taskId: id })),
                      ),
                    );
            // A ref, when given, is the only source: a plain secret sent
            // alongside it must not replace what a replayed save stored.
            const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
            const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
            const secretChanged = signature == null || provided !== undefined || existing === null;
            if (signature != null && secret === null && (!work || input.enabled)) {
              return yield* taskError("A webhook signature check needs a signing secret.", {
                taskId: id,
              });
            }
            const secretRef =
              signature?.secretRef !== undefined && fromRef !== undefined
                ? signature.secretRef
                : null;
            return { token, secret, secretChanged, secretRef };
          })
        : { token: null, secret: null, secretChanged: true, secretRef: null };
    return {
      schedule:
        work && schedule.type === "webhook" && schedule.signature !== null
          ? {
              ...schedule,
              signature: { ...schedule.signature, secretSet: webhook.secret !== null },
            }
          : schedule,
      webhook,
    };
  },
);
