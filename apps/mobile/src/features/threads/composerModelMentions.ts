import { rankComposerModelMentions } from "@goat/client-runtime/composer-model-mentions";
import type { ServerProvider } from "@goat/contracts";
import type { ModelOption } from "../../lib/modelOptions";

export type ComposerModelItem = {
  readonly id: string;
  readonly type: "model";
  readonly option: ModelOption;
  readonly label: string;
  readonly description: string;
};

export function buildComposerModelItems(
  options: ReadonlyArray<ModelOption>,
  query: string,
  providers: ReadonlyArray<ServerProvider>,
): ComposerModelItem[] {
  const ready = new Set(
    providers
      .filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          provider.status === "ready" &&
          provider.auth.status !== "unauthenticated" &&
          provider.availability !== "unavailable",
      )
      .map((provider) => provider.instanceId),
  );
  return rankComposerModelMentions(
    options.filter(
      (option) =>
        ready.has(option.selection.instanceId) &&
        !option.isUnavailable &&
        !option.isHidden &&
        !option.isLegacy,
    ),
    query,
    (option) => ({
      name: option.label,
      ...(option.subtitle ? { subProvider: option.subtitle } : {}),
      driverKind: option.providerDriver,
      providerDisplayName: option.providerLabel,
    }),
  ).map((option) => ({
    id: `model:${option.key}`,
    type: "model",
    option,
    label: option.label,
    description: option.subtitle
      ? `${option.providerLabel} · ${option.subtitle}`
      : option.providerLabel,
  }));
}
