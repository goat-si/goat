import { ProviderDriverKind } from "@goat/contracts";
import {
  ACP_REGISTRY_MODEL_SELECTION,
  READ_ONLY_NEVER_POLICY,
  type OrchestratorReplayFixture,
} from "../shared.ts";
import { acpTitledMultiSelectInput } from "./input.ts";
import { assertAcpTitledMultiSelectOutput } from "./output.ts";

export const acpTitledMultiSelectFixture: OrchestratorReplayFixture = {
  name: "acp_titled_multiselect",
  buildInput: acpTitledMultiSelectInput,
  providers: [
    {
      driver: ProviderDriverKind.make("acpRegistry"),
      transcriptFile: new URL("./registry_transcript.ndjson", import.meta.url),
      modelSelection: ACP_REGISTRY_MODEL_SELECTION,
      runtimePolicyOverride: READ_ONLY_NEVER_POLICY,
      assertOutput: assertAcpTitledMultiSelectOutput,
    },
  ],
};
