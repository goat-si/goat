import { isProviderDriverKind } from "@goat/contracts";
import { acpRegistryClient } from "@goat/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@goat/provider-core/client";
import { cursorClient, cursorCloudClient } from "@goat/provider-cursor/client";
import { devinCloudClient } from "@goat/provider-devin-cloud/client";
import { claudeCloudClient } from "@goat/provider-claude-cloud/client";
import { fxClient } from "@goat/provider-fx/client";
import { grokClient } from "@goat/provider-grok/client";
import { museClient } from "@goat/provider-muse/client";
import { openCodeClient } from "@goat/provider-opencode/client";
import { piClient } from "@goat/provider-pi/client";

const providerClients = makeProviderClientRegistry([
  cursorClient,
  cursorCloudClient,
  claudeCloudClient,
  grokClient,
  fxClient,
  museClient,
  openCodeClient,
  piClient,
  acpRegistryClient,
  devinCloudClient,
]);

export function getProviderClient(driver: string | null | undefined) {
  return isProviderDriverKind(driver) ? providerClients.get(driver) : undefined;
}
