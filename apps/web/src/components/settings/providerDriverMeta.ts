import {
  AntigravitySettings,
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
} from "@goat/contracts";
import { acpRegistryClient } from "@goat/provider-acp-registry/client";
import { makeProviderClientRegistry } from "@goat/provider-core/client";
import { cursorClient, cursorCloudClient } from "@goat/provider-cursor/client";
import { devinCloudClient } from "@goat/provider-devin-cloud/client";
import { claudeCloudClient } from "@goat/provider-claude-cloud/client";
import { grokClient } from "@goat/provider-grok/client";
import { museClient } from "@goat/provider-muse/client";
import { openCodeClient } from "@goat/provider-opencode/client";
import { piClient } from "@goat/provider-pi/client";

/** The provider client definitions this web build ships, in presentation order. */
export const providerClients = makeProviderClientRegistry([
  {
    driverKind: ProviderDriverKind.make("codex"),
    label: "Codex",
    settingsSchema: CodexSettings,
  },
  {
    driverKind: ProviderDriverKind.make("claudeAgent"),
    label: "Claude",
    settingsSchema: ClaudeSettings,
  },
  cursorClient,
  cursorCloudClient,
  claudeCloudClient,
  grokClient,
  openCodeClient,
  {
    driverKind: ProviderDriverKind.make("antigravity"),
    label: "Antigravity",
    settingsSchema: AntigravitySettings,
  },
  museClient,
  piClient,
  acpRegistryClient,
  devinCloudClient,
]);
