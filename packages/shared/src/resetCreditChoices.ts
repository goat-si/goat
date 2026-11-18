import type { ProviderConsumeResetCreditInput, ServerProviderResetCredits } from "@goat/contracts";
import { formatDuration } from "./usageDuration.ts";

/** One redeemable reset as clients offer it; `input` already names the chosen credit. */
export interface ResetCreditChoice {
  readonly key: string;
  readonly summary: string;
  readonly actionLabel: string;
  readonly confirmDescription: string;
  readonly availableCount: number;
  readonly input: ProviderConsumeResetCreditInput;
}

export function resetCreditChoices(
  credits: ServerProviderResetCredits,
  input: ProviderConsumeResetCreditInput,
  now: number,
  compact = false,
): ReadonlyArray<ResetCreditChoice> {
  const expiresIn = (at: string | undefined) => (at ? formatDuration(Date.parse(at) - now) : null);
  if (credits.options && "sourceId" in input) {
    return [
      {
        key: "unsupported",
        summary:
          "This hub cannot select a reset grant. Redeem through the account's local connection.",
        actionLabel: "Use",
        confirmDescription: "",
        availableCount: 0,
        input,
      },
    ];
  }
  if (credits.options && "instanceId" in input) {
    return credits.options.map((option) => {
      const expires = expiresIn(option.expiresAt);
      return {
        key: option.creditId,
        summary: `${option.label} · ${option.availableCount} left${expires ? ` · expires in ${expires}` : ""}`,
        actionLabel: "Use",
        confirmDescription: `${option.label}: ${option.description} This cannot be undone.`,
        availableCount: option.availableCount,
        input: { ...input, creditId: option.creditId },
      };
    });
  }
  const count = credits.availableCount;
  const expires = expiresIn(credits.nextExpiresAt);
  return [
    {
      key: "next",
      summary:
        count === 0
          ? "No reset credits banked"
          : compact
            ? `${count} banked${expires ? ` · expires in ${expires}` : ""}`
            : `${count} ${count === 1 ? "reset credit" : "reset credits"} banked${expires ? ` · next expires in ${expires}` : ""}`,
      actionLabel: "Use reset",
      confirmDescription:
        "This redeems one credit on your account and clears the current rate-limit windows. It cannot be undone.",
      availableCount: count,
      input,
    },
  ];
}
