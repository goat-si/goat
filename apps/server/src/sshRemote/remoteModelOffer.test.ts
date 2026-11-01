import type { OrchestratorMcpCapabilitiesResult } from "@goat/contracts";
import { ProviderInstanceId } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { remoteModelOffer } from "./remoteModelOffer.ts";

const codex = ProviderInstanceId.make("codex");

/** A remote whose cached catalog becomes `refreshed` once it is asked to refresh. */
const remote = (cached: ReadonlyArray<string>, refreshed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const catalog = yield* Ref.make(cached);
    const refreshes = yield* Ref.make(0);
    const capabilities = Ref.get(catalog).pipe(
      Effect.map(
        (models) =>
          ({
            providers: [
              { providerInstanceId: codex, models: models.map((id) => ({ id, label: null })) },
            ],
          }) as unknown as OrchestratorMcpCapabilitiesResult,
      ),
    );
    const refresh = Ref.update(refreshes, (count) => count + 1).pipe(
      Effect.andThen(Ref.set(catalog, refreshed)),
    );
    return { capabilities, refresh, refreshes: Ref.get(refreshes) };
  });

it.effect("a model the remote gained since its last probe is offered after one refresh", () =>
  Effect.gen(function* () {
    const host = yield* remote(["gpt"], ["gpt", "anthropic/claude-opus-5-5"]);
    const offer = yield* remoteModelOffer({
      selection: { instanceId: codex, model: "anthropic/claude-opus-5-5" },
      ...host,
    });
    expect(offer).toBe("offered");
    expect(yield* host.refreshes).toBe(1);
  }),
);

it.effect("a model the remote still lacks after the refresh is reported missing", () =>
  Effect.gen(function* () {
    const host = yield* remote(["gpt"], ["gpt"]);
    const offer = yield* remoteModelOffer({
      selection: { instanceId: codex, model: "nope" },
      ...host,
    });
    expect(offer).toBe("missing");
    expect(yield* host.refreshes).toBe(1);
  }),
);

it.effect("a listed model or an unknown instance needs no refresh", () =>
  Effect.gen(function* () {
    const host = yield* remote(["gpt"], []);
    expect(
      yield* remoteModelOffer({ selection: { instanceId: codex, model: "gpt" }, ...host }),
    ).toBe("offered");
    const other = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "gpt" };
    expect(yield* remoteModelOffer({ selection: other, ...host })).toBe("no_instance");
    expect(yield* host.refreshes).toBe(0);
  }),
);
