import { en, type Messages } from "./en";
import { ko } from "./ko";

export type Locale = "en" | "ko";
export type { Messages };

export const LOCALES: ReadonlyArray<Locale> = ["en", "ko"];

const MESSAGES: Record<Locale, Messages> = { en, ko };

export function messages(locale: Locale): Messages {
  return MESSAGES[locale];
}

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "ko" : "en";
}
