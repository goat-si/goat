import { Persistence } from "@goat/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox-removal";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { clearThreadComposerErrorsForEnvironment } from "../state/thread-composer-error";
import { mobileThreadTriageOutboxStore } from "../state/thread-triage-outbox-storage";

const CLEAR_TIMEOUT_MS = 5_000;

export const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) => {
      const settle = (operation: string, clear: () => void | Promise<void>) =>
        Effect.tryPromise({
          try: () => Promise.resolve().then(clear),
          catch: (cause) => cause,
        }).pipe(
          Effect.timeout(CLEAR_TIMEOUT_MS),
          Effect.catch((cause) =>
            Effect.logWarning("Could not clear mobile environment-owned data.", {
              environmentId,
              operation,
              cause,
            }),
          ),
        );
      return Effect.all(
        [
          settle("outbox", () => clearThreadOutboxEnvironment(environmentId)),
          settle("drafts", () => clearComposerDraftsEnvironment(environmentId)),
          settle("bot", async () => {
            const { disposeMobileGoatBotEnvironment } =
              await import("../features/goat-bot/useMobileGoatBotSession");
            await disposeMobileGoatBotEnvironment(environmentId);
          }),
          settle("new-bot", async () => {
            const { forgetNewBotEnvironment } = await import("@goat/client-runtime/goatBot");
            forgetNewBotEnvironment(environmentId);
          }),
          settle("composer-errors", () => clearThreadComposerErrorsForEnvironment(environmentId)),
          Effect.ignore(mobileThreadTriageOutboxStore.clearEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      );
    },
  }),
);
