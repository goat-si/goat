import { SessionMessage } from "@opencode/client/effect";

// msg_ IDs cannot cross sessions; include session identity because GOAT IDs repeat across environments.
// Pre-acknowledgement IDs also establish fork/rollback boundaries.
export const turnPromptId = (sessionId: string, attemptId: string) =>
  SessionMessage.ID.make(`msg_t3_turn_${sessionId}:${attemptId}`);
export const steerPromptId = (sessionId: string, messageId: string) =>
  SessionMessage.ID.make(`msg_t3_steer_${sessionId}:${messageId}`);
