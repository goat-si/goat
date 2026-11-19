import type { OrchestrationV2Command } from "@goat/contracts";
import { personIngress } from "../handoffs/HumanStepAuthority.ts";
import { withCreationProvenance } from "./ThreadManagementService.ts";

export function stampClientCommand(
  command: OrchestrationV2Command,
  session: Parameters<typeof personIngress>[0],
) {
  const attributed = withCreationProvenance(command, {
    createdBy: "user",
    creationSource: "creationSource" in command ? command.creationSource : "web",
  });
  if (attributed.type !== "message.dispatch") return attributed;
  return {
    ...attributed,
    ingress: attributed.guestMessageId === undefined ? personIngress(session) : undefined,
  };
}

export { personIngress };
