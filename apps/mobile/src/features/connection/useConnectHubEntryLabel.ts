import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { splitEnvironmentSections } from "./environmentSections";

/**
 * Label for entry points that open the pairing screen without an intent: the screen becomes
 * Change hub once a server is saved, so the button has to say so.
 */
export function useConnectHubEntryLabel(): "Connect hub" | "Change hub" {
  const { connectedEnvironments } = useRemoteConnections();
  const { localEnvironments } = splitEnvironmentSections({
    connectedEnvironments,
    cloudEnvironments: null,
  });
  return localEnvironments.length === 0 ? "Connect hub" : "Change hub";
}
