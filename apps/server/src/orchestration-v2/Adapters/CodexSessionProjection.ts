import {
  ProviderDriverKind,
  type OrchestrationV2ProviderSession,
  type ProviderInstanceId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import { CodexProviderCapabilitiesV2 } from "./CodexCapabilities.ts";

export function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}
