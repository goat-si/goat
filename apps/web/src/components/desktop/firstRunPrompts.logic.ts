import type {
  ClientSettings,
  FirstRunPromptId,
  FirstRunPrompts,
  OpenCodexInventorySnapshot,
} from "@goat/contracts";

/**
 * Carries the answer of the computer-use prompt from before firstRunPrompts existed, so a
 * profile that already answered is not asked again.
 */
export function foldLegacyFirstRunPrompt(settings: ClientSettings): ClientSettings {
  const { computerUsePrompt, ...rest } = settings;
  if (computerUsePrompt === undefined) return settings;
  if (computerUsePrompt === "pending" || rest.firstRunPrompts.computerUse !== "pending")
    return rest;
  return {
    ...rest,
    firstRunPrompts: {
      ...rest.firstRunPrompts,
      computerUse: computerUsePrompt === "enabled" ? "answered" : "later",
    },
  };
}

export type OpenCodexSituation =
  | { readonly kind: "home"; readonly devices: number }
  | { readonly kind: "linked"; readonly homeName: string | null }
  | { readonly kind: "unlinked" };

/** Null when OpenCodex is not installed here, so there is nothing to connect. */
export function openCodexSituation(
  inventory: OpenCodexInventorySnapshot | undefined,
): OpenCodexSituation | null {
  if (inventory === undefined || !inventory.installed) return null;
  if (inventory.link.role === "home") return { kind: "home", devices: inventory.link.links.length };
  if (inventory.link.role === "child" || inventory.hubClient?.state === "connected")
    return { kind: "linked", homeName: inventory.link.homeName ?? null };
  return { kind: "unlinked" };
}

export interface FirstRunPromptInput {
  readonly prompts: FirstRunPrompts;
  /** "loading" until this machine's host status answers. */
  readonly opencodex: OpenCodexSituation | null | "loading";
  /** The Codex instance Connect opens; null when this environment has none. */
  readonly codexInstanceId: string | null;
  readonly codexUsesHome: boolean;
  /** Hub or permission profiles is already on. */
  readonly goatclawOn: boolean;
  readonly canConfigure: boolean;
}

export interface FirstRunPromptPlan {
  /** One dialog at a time; computer use decides for itself whether its host can be asked. */
  readonly show: FirstRunPromptId | null;
  /** Prompts whose question was already answered elsewhere, to record without asking. */
  readonly answeredElsewhere: ReadonlyArray<FirstRunPromptId>;
}

export function planFirstRunPrompts(input: FirstRunPromptInput): FirstRunPromptPlan {
  const answeredElsewhere: FirstRunPromptId[] = [];
  const pending = (id: FirstRunPromptId) => input.prompts[id] === "pending";
  const plan = (show: FirstRunPromptId | null) => ({ show, answeredElsewhere });

  if (pending("opencodex") && input.codexUsesHome) answeredElsewhere.push("opencodex");
  if (pending("goatclaw") && input.goatclawOn) answeredElsewhere.push("goatclaw");
  const asks = (id: FirstRunPromptId) => pending(id) && !answeredElsewhere.includes(id);

  if (asks("opencodex") || asks("goatclaw")) {
    // Asking computer use first would stack two dialogs once host status answers.
    if (input.opencodex === "loading") return plan(null);
    const situation = input.opencodex;
    if (asks("opencodex") && situation !== null && input.codexInstanceId !== null)
      return plan("opencodex");
    // A linked device follows its Home; only a Home or a standalone install can become the hub.
    if (asks("goatclaw") && input.canConfigure && situation !== null && situation.kind !== "linked")
      return plan("goatclaw");
  }
  return plan(pending("computerUse") ? "computerUse" : null);
}

/** "merge-manager" reads "Merge manager". */
export function profileLabel(id: string): string {
  const words = id.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
