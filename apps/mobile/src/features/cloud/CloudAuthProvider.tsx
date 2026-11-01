import { ClerkProvider, getClerkInstance } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { setManagedRelaySession } from "@goat/client-runtime/relay";
import type { ReactNode } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { releaseAgentAwarenessRelayTokenProvider } from "../agent-awareness/remoteRegistration";
import { cloudAccountService } from "./cloudAccountService";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

const cloudConfig = resolveCloudPublicConfig();
// Build-time constant: null when this build has no cloud config.
const publishableKey = hasCloudPublicConfig() ? cloudConfig.clerk.publishableKey : null;

if (publishableKey) {
  // The same native singleton ClerkProvider renders with, so the service
  // observes it for the app's lifetime without a React subscription.
  cloudAccountService.attach(getClerkInstance({ publishableKey }));
} else {
  // Disabling Connect detaches the active token without signing the account out.
  releaseAgentAwarenessRelayTokenProvider();
  setManagedRelaySession(appAtomRegistry, null);
}

export function CloudAuthProvider(props: { readonly children: ReactNode }) {
  if (!publishableKey) {
    return props.children;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {props.children}
    </ClerkProvider>
  );
}
