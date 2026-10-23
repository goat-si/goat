import { OrchestratorMcpFailure } from "@goat/contracts";
import { surfaceArguments } from "@goat/contracts/agentSurface/callArguments";

/** goat_describe's and goat_call's payload with its aliases folded in, or the refusal of a conflict. */
export const surfaceArgumentAliases = (
  tool: string,
  payload: unknown,
):
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly failure: OrchestratorMcpFailure } => {
  const folded = surfaceArguments(tool, payload);
  if (folded.ok) return folded;
  const [a, b] = folded.conflict;
  return {
    ok: false,
    failure: new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `${tool} got both ${a} and ${b}, which name different things, so nothing ran. Pass one.`,
    }),
  };
};
