import type {
  CodexGoalBlock,
  CodexInstanceRecordKey,
  CodexStopObligation,
} from "./CodexSurvivors.ts";

export const sameStop = (a: CodexStopObligation, b: CodexStopObligation) =>
  a.threadId === b.threadId &&
  a.nativeThreadId === b.nativeThreadId &&
  a.nativeTurnId === b.nativeTurnId;

export const sameGoal = (a: CodexGoalBlock, b: CodexGoalBlock) =>
  a.threadId === b.threadId && a.nativeThreadId === b.nativeThreadId;

export const stopKey = (key: CodexInstanceRecordKey, stop: CodexStopObligation) =>
  JSON.stringify([
    "stop",
    key.instanceId,
    key.recordName,
    stop.threadId,
    stop.nativeThreadId,
    stop.nativeTurnId,
  ]);

export const goalKey = (key: CodexInstanceRecordKey, goal: CodexGoalBlock) =>
  JSON.stringify(["goal", key.instanceId, key.recordName, goal.threadId, goal.nativeThreadId]);
