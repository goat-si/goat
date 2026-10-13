import { isProviderDriverKind } from "@goat/contracts";
import { acpRegistryClient } from "@goat/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@goat/provider-core/client";
import { cursorClient } from "@goat/provider-cursor/client";
import { devinCloudClient } from "@goat/provider-devin-cloud/client";
import { grokClient } from "@goat/provider-grok/client";
import { museClient } from "@goat/provider-muse/client";
import { openCodeClient } from "@goat/provider-opencode/client";
import { piClient } from "@goat/provider-pi/client";

/** The provider client definitions this mobile build ships. */
const providerClients = makeProviderClientRegistry([
  cursorClient,
  grokClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
  devinCloudClient,
]);

/** The client definition for a driver kind, or `undefined` for drivers drawn by hand. */
export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
