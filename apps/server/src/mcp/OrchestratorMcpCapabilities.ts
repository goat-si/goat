import {
  OrchestratorMcpCapabilitiesResult,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";

/**
 * Large catalogs (OpenCode, Cursor, Pi) can list hundreds of models, so agents
 * get a short list by default and search for the rest. These providers have
 * small official catalogs, so all their current models are listed.
 */
const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODEL_LIMIT = 8;

/**
 * Whole provider words select the provider; partial words filter models when any match. An
 * empty search shows pinned and current models.
 */
export function listCapabilityModels(input: {
  readonly provider: ServerProvider;
  readonly preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly isPinned: (model: ServerProviderModel) => boolean;
  readonly searchTerms: ReadonlyArray<string>;
}) {
  const rank = new Map(input.preferences?.modelOrder.map((slug, index) => [slug, index]));
  const visible = input.provider.models
    .filter((model) => model.isCustom || !input.preferences?.hiddenModels.includes(model.slug))
    .toSorted((a, b) => (rank.get(a.slug) ?? rank.size) - (rank.get(b.slug) ?? rank.size));
  const { instanceId, driver, displayName } = input.provider;
  const providerText = `${instanceId} ${driver} ${displayName ?? ""}`.toLowerCase();
  // Whole ids like "codex-work" and their parts both name the provider.
  const providerWords = new Set([
    ...providerText.split(/\s+/),
    ...providerText.split(/[^\p{L}\p{N}]+/u),
  ]);
  const modelText = (model: ServerProviderModel) =>
    `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
  // Part of a provider word ("agent" in "claudeAgent") names the provider unless a model matches it.
  const modelTerms = input.searchTerms.filter(
    (term) =>
      !providerWords.has(term) &&
      (!providerText.includes(term) || visible.some((model) => modelText(model).includes(term))),
  );
  if (modelTerms.length > 0) {
    const matches = visible.filter((model) =>
      modelTerms.every((term) => modelText(model).includes(term)),
    );
    // A slug matching a term exactly is listed first, above the cap: a caller asking for a
    // model by name can trust a yes/no from the response without paging through the omitted.
    const exact = new Set(
      matches
        .filter((model) => input.searchTerms.some((term) => model.slug.toLowerCase() === term))
        .map((model) => model.slug),
    );
    const listed = [
      ...matches.filter((model) => exact.has(model.slug)),
      ...matches.filter((model) => !exact.has(model.slug)).slice(0, LISTED_MODEL_LIMIT),
    ];
    return { listed, omitted: matches.length - listed.length };
  }
  const current = visible.filter((model) => !model.isLegacy);
  const shown = new Set(
    FULL_CATALOG_DRIVERS.has(input.provider.driver)
      ? current
      : current.slice(0, LISTED_MODEL_LIMIT),
  );
  const listed = visible.filter((model) => input.isPinned(model) || shown.has(model));
  return { listed, omitted: visible.length - listed.length };
}

const decodeCapabilities = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);

/** One advertised model row, as orchestrator_capabilities reports it. */
export type AdvertisedModel =
  OrchestratorMcpCapabilitiesResult["providers"][number]["models"][number];

/**
 * One targeted capabilities refresh for a model the untargeted listing omitted. That listing
 * truncates, so absence is not conclusive; a host on this GOAT version pins an exact slug
 * match above the cap. Only the selected account's row counts. Every failure softens to
 * None, leaving the caller's previous refusal in place.
 */
export const readAdvertisedModel = <E, R>(
  ssh: SshRemoteDispatch.SshRemoteDispatch["Service"],
  authorize: Effect.Effect<RuntimeMode, E, R>,
  input: { readonly host: string; readonly providerInstanceId: string; readonly model: string },
): Effect.Effect<Option.Option<AdvertisedModel>, never, R> =>
  ssh
    .callHostTool(
      {
        host: input.host,
        tool: "orchestrator_capabilities",
        arguments: { search: input.model },
        writes: false,
        timeoutMs: 120_000,
      },
      authorize,
    )
    .pipe(
      Effect.flatMap(decodeCapabilities),
      Effect.option,
      Effect.map(
        Option.flatMap((catalog) =>
          Option.fromNullishOr(
            catalog.providers
              .find((provider) => provider.providerInstanceId === input.providerInstanceId)
              ?.models.find((model) => model.id === input.model),
          ),
        ),
      ),
    );
