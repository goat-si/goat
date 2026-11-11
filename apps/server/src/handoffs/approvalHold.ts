import {
  BROWSER_CLAIM_ANSWER_HANDOFF_PATH,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type Handoff,
  HandoffError,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

/**
 * Approvals that hold their thread while a person has not answered (D2): one open approval per
 * thread, so an agent waits for that answer instead of piling up cards. Computer use and browser
 * tab admissions keep their own rules: a newer request supersedes, and their call waits.
 */
export const holdsThread = (handoff: Pick<Handoff, "kind" | "target">) =>
  handoff.kind === "approval" &&
  handoff.target.path !== COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.target.path !== BROWSER_CLAIM_ANSWER_HANDOFF_PATH;

/** The refusal for a new approval while `open` waits; it names the card and the way out. */
export const heldBy = (open: Handoff) =>
  new HandoffError({
    reason: "limit_reached",
    detail: `This thread is waiting for a person to answer the approval "${open.title}" (${open.handoffId}, ${open.target.path}). A person has not answered it yet. End this turn; GOAT wakes this thread when they answer. To ask for something else instead, withdraw it first with ${goatCallText("handoff.withdraw", `{handoffId:"${open.handoffId}"}`)}.`,
  });

/** A failed ask keeps the hold's words, so the agent learns which card it waits on. */
export const approvalAskFailure = (error: HandoffError) =>
  new OrchestratorMcpFailure(
    error.reason === "limit_reached"
      ? { code: "invalid_request", message: error.message }
      : { code: "orchestration_error", message: "Could not ask for approval." },
  );
