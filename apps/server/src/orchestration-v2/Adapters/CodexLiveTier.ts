import type { ModelSelection } from "@goat/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import type { ActiveCodexTurnContext } from "./CodexAdapterV2.ts";

export function makeCodexLiveTier(
  client: CodexClient.CodexAppServerClient["Service"],
  activeTurns: Ref.Ref<Map<string, ActiveCodexTurnContext>>,
  enabled: boolean,
) {
  return Effect.fn("CodexLiveTier.apply")(function* (threadId: string, selection: ModelSelection) {
    if (!enabled) return;
    const turns = [...(yield* Ref.get(activeTurns)).values()].filter(
      (turn) => turn.providerThread.nativeThreadRef?.nativeId === threadId,
    );
    if (turns.length === 0) return;
    const tier = getCodexServiceTierOptionValue(selection) ?? "default";
    if (
      turns.every(
        (turn) =>
          (getCodexServiceTierOptionValue(turn.liveTierSelection ?? turn.input.modelSelection) ??
            "default") === tier,
      )
    )
      return;
    const applied = yield* client
      .request("thread/settings/update", { threadId, serviceTier: tier })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("orchestration-v2.codex-service-tier-update-failed", { cause }).pipe(
            Effect.as(false),
          ),
        ),
      );
    if (applied)
      for (const turn of turns)
        turn.liveTierSelection = {
          ...turn.input.modelSelection,
          options: [
            ...(turn.input.modelSelection.options ?? []).filter(
              (option) => option.id !== "serviceTier" && option.id !== "fastMode",
            ),
            { id: "serviceTier", value: tier },
          ],
        };
  });
}
