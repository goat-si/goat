import { RegistryContext } from "@effect/atom-react";
import type { ReactNode } from "react";

import { CloudAuthProvider } from "./features/cloud/CloudAuthProvider";
import { AppearancePreferencesProvider } from "./features/settings/appearance/AppearancePreferencesProvider";
import { appAtomRegistry } from "./state/atom-registry";

/** The providers every screen, sheet and overlay of the app renders inside. */
export function AppProviders(props: { readonly children: ReactNode }) {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <CloudAuthProvider>
        <AppearancePreferencesProvider>{props.children}</AppearancePreferencesProvider>
      </CloudAuthProvider>
    </RegistryContext.Provider>
  );
}
