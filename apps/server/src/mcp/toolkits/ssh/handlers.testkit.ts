import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Layer from "effect/Layer";

import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Permission profiles with GOAT Bot off, or on with the named default profile. */
export const profileLayer = (id?: string) => {
  const base = Profiles.layer.pipe(
    Layer.provide(
      PermissionSettings.layerTest({
        goatclaw: { enabled: id !== undefined, defaultProfile: id ?? "worker" },
      }),
    ),
  );
  return id === undefined ? base : base.pipe(Layer.provide(Sqlite.layerMemory));
};

export const threadId = ThreadId.make("ssh-caller");
export const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:ssh-attachments"),
  requestNamespace: "provider:ssh-attachments",
  thread: {
    threadId,
    providerSessionId: "provider:ssh-attachments",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
