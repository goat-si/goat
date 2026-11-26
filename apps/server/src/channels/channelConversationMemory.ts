import type { AuthEnvironmentScope, ChannelReceptionInput } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as MemoryAccess from "../memory/MemoryAccess.ts";
import * as MemoryService from "../memory/MemoryService.ts";
import * as MemorySyncService from "../memory/MemorySyncService.ts";
import * as Settings from "../serverSettings.ts";
import { boundRecall, RECALL_MEMORY_LINES } from "./channelBotRecall.ts";

export const makeChannelMemorySearch = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const memory = yield* Effect.serviceOption(MemoryService.MemoryService);
  const sync = yield* Effect.serviceOption(MemorySyncService.MemorySyncService);
  const policy = yield* Effect.serviceOption(Settings.MemoryProviderCommittedPolicy);
  const search = Effect.fn("ChannelConversationMemory.search")(
    function* (
      checkPolicy: MemoryAccess.MemoryPermit | undefined,
      grantedScopes: ReadonlyArray<AuthEnvironmentScope>,
      liveScopes: Effect.Effect<ReadonlyArray<AuthEnvironmentScope>>,
      query: string,
    ) {
      if (!checkPolicy || Option.isNone(memory) || Option.isNone(sync)) return [];
      yield* checkPolicy;
      if (!(yield* liveScopes).includes("memory:read")) return [];
      if (!(yield* settings.getSettings).memoryEnabled) return [];
      const readiness = yield* sync.value.readLocalReadiness();
      if (readiness.bootstrap !== "ready" || readiness.memorySpaceId === null) return [];
      const page = yield* memory.value.search(
        {
          memorySpaceId: readiness.memorySpaceId,
          query: query.trim().normalize("NFC"),
          limit: RECALL_MEMORY_LINES,
          mode: "fts",
        },
        MemoryAccess.memoryAccessPermit(
          {
            grantedScopes,
            readOnly: true,
            liveCaller: checkPolicy,
            reauthorize: (required) =>
              liveScopes.pipe(
                Effect.flatMap((scopes) =>
                  required.every((scope) => scopes.includes(scope))
                    ? Effect.void
                    : Effect.fail(new MemoryService.MemoryAccessError({ code: "unavailable" })),
                ),
              ),
          },
          "read",
        ),
      );
      return page.items.flatMap((item) =>
        item.status === "active" ? ["- " + item.payload.text.replace(/\s+/gu, " ").trim()] : [],
      );
    },
    Effect.catch((cause) =>
      Effect.logInfo("GOAT Bot memory search skipped", { cause }).pipe(Effect.as([])),
    ),
  );
  return {
    search,
    admit: Effect.gen(function* () {
      if (Option.isSome(policy))
        return yield* MemoryAccess.issueConversationMemoryPermit(policy.value.read);
    }),
  };
});

/** Keep the local fallback and the model turn's original grant outside the provider input. */
export function channelMemoryReadBatch(permit: MemoryAccess.MemoryPermit | undefined) {
  const fallbacks = new Map<number, string>();
  return {
    permit,
    format(index: number, localLines: ReadonlyArray<string>, goatLines: ReadonlyArray<string>) {
      const notes = localLines.length ? ["GOAT Bot notes and journal:", ...localLines] : [];
      const local = notes.length ? notes.join("\n") : "Nothing in memory matches.";
      if (!goatLines.length) return local;
      fallbacks.set(index, boundRecall(local));
      return [...notes, "GOAT memory:", ...goatLines].join("\n");
    },
    recheck: Effect.fn("ChannelMemoryReadBatch.recheck")(function* (input: ChannelReceptionInput) {
      if (
        !input.readResults?.length ||
        !fallbacks.size ||
        (permit && (yield* Effect.isSuccess(permit)))
      )
        return input;
      return {
        ...input,
        readResults: input.readResults.map((result, index) => {
          const fallback = fallbacks.get(index);
          return fallback === undefined ? result : { ...result, text: fallback };
        }),
      };
    }),
  };
}
