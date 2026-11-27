import { RegistryContext } from "@effect/atom-react";
import type { ReactNode } from "react";

import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "./features/settings/appearance/AppearancePreferencesProvider";
import { I18nProvider } from "./i18n/I18nProvider";
import { appAtomRegistry } from "./state/atom-registry";

/** The providers every screen, sheet and overlay of the app renders inside. GT hooks throw outside I18nProvider. */
export function AppProviders(props: { readonly children: ReactNode }) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>
          <I18nProvider>{props.children}</I18nProvider>
        </AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
