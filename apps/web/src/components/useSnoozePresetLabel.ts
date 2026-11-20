import { SnoozePresetDay, type SnoozePresetSetting } from "@goat/contracts";
import { msg, useGT, useLocale, useMessages } from "gt-react";

export const UNIT_MINUTES = { minutes: 1, hours: 60, days: 24 * 60 } as const;
export type DurationUnit = keyof typeof UNIT_MINUTES;

export const WHEN_LABELS: Record<"after" | SnoozePresetDay, string> = {
  after: msg("In"),
  today: msg("Today"),
  tomorrow: msg("Tomorrow"),
  monday: msg("Monday"),
  tuesday: msg("Tuesday"),
  wednesday: msg("Wednesday"),
  thursday: msg("Thursday"),
  friday: msg("Friday"),
  saturday: msg("Saturday"),
  sunday: msg("Sunday"),
};
export const WHEN_VALUES = ["after", ...SnoozePresetDay.literals] as const;

// Labels client-runtime's resolveSnoozePreset returns that WHEN_LABELS does not declare.
const RESOLVED_DAY_LABELS: Readonly<Record<string, string>> = {
  "This morning": msg("This morning"),
  "This afternoon": msg("This afternoon"),
  "This evening": msg("This evening"),
  "Next week": msg("Next week"),
};

export function splitMinutes(minutes: number): { amount: number; unit: DurationUnit } {
  if (minutes % UNIT_MINUTES.days === 0) {
    return { amount: minutes / UNIT_MINUTES.days, unit: "days" };
  }
  if (minutes % UNIT_MINUTES.hours === 0) {
    return { amount: minutes / UNIT_MINUTES.hours, unit: "hours" };
  }
  return { amount: minutes, unit: "minutes" };
}

/** Keep the settings preview and sidebar menu wording in sync. */
export function useSnoozePresetLabel() {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const relative = new Intl.RelativeTimeFormat(locale);
  return (preset: SnoozePresetSetting, daysAhead: number, label: string) => {
    if (preset.kind === "after") {
      const { amount, unit } = splitMinutes(preset.minutes);
      const text = relative.format(amount, unit);
      return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
    }
    return daysAhead === 7 && preset.day !== "monday"
      ? gt("Next {weekday}", { weekday: m(WHEN_LABELS[preset.day]) })
      : m(
          RESOLVED_DAY_LABELS[label] ??
            (daysAhead === 1 ? WHEN_LABELS.tomorrow : WHEN_LABELS[preset.day]),
        );
  };
}
