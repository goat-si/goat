// v1's gt-react setup (apps/web/src/i18n/initializeI18n.ts + I18nProvider.tsx at goat 916b5ccc1b2) for the lifted
// surfaces. GOAT 2 is English first (owner rule), and English is v1's source text, so no translation chunk is loaded:
// v1's initializeGTSPA call with only its default locale, and its GTProvider with empty translations.
import { GTProvider, initializeGTSPA } from "gt-react";
import type { ReactNode } from "react";

const DEFAULT_LOCALE = "en"; // v1 apps/web/gt.config.json defaultLocale

let initialized = false;
function ensureInitialized() {
  if (initialized) return;
  initialized = true;
  void initializeGTSPA({ defaultLocale: DEFAULT_LOCALE, locales: [DEFAULT_LOCALE], locale: DEFAULT_LOCALE, loadTranslations: async () => ({}) });
}

export function V1I18n({ children }: { children: ReactNode }) {
  ensureInitialized();
  return <GTProvider locale={DEFAULT_LOCALE} translations={{}}>{children}</GTProvider>;
}
