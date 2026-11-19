import { Persistence } from "@goat/client-runtime/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { clearThreadOutboxEnvironment } from "../state/thread-outbox-removal";
import { clearComposerDraftsEnvironment } from "../state/use-composer-drafts";
import { clearThreadComposerErrorsForEnvironment } from "../state/thread-composer-error";

export const layerEnvironmentOwnedDataCleanup = Layer.succeed(
  Persistence.EnvironmentOwnedDataCleanup,
  Persistence.EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) =>
      Effect.all(
        [
          Effect.promise(() => clearThreadOutboxEnvironment(environmentId)),
          Effect.promise(() => clearComposerDraftsEnvironment(environmentId)),
          Effect.promise(async () => {
            const { disposeMobileGoatBotEnvironment } =
              await import("../features/goat-bot/useMobileGoatBotSession");
            await disposeMobileGoatBotEnvironment(environmentId);
          }),
          Effect.promise(async () => {
            const { forgetNewBotEnvironment } = await import("@goat/client-runtime/goatBot");
            forgetNewBotEnvironment(environmentId);
          }),
          Effect.sync(() => clearThreadComposerErrorsForEnvironment(environmentId)),
        ],
        { concurrency: "unbounded", discard: true },
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not clear mobile environment-owned data.", {
            environmentId,
            cause,
          }),
        ),
      ),
  }),
);
