export const emitXAiAskUserQuestion = process.env.GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";
export const emitXAiExitPlanMode = process.env.GOAT_ACP_EMIT_XAI_EXIT_PLAN_MODE === "1";
export const emitXAiPlanMdWrite = process.env.GOAT_ACP_EMIT_XAI_PLAN_MD_WRITE === "1";
export const emitXAiPromptCompleteThenHang =
  process.env.GOAT_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";
export const emitXAiRateLimitThenHang = process.env.GOAT_ACP_EMIT_XAI_RATE_LIMIT_THEN_HANG === "1";
export const emitXAiAskUserQuestionThenHang =
  process.env.GOAT_ACP_EMIT_XAI_ASK_USER_QUESTION_THEN_HANG === "1";
export const emitContentThenHang = process.env.GOAT_ACP_EMIT_CONTENT_THEN_HANG === "1";
export const emitPlanThenHang = process.env.GOAT_ACP_EMIT_PLAN_THEN_HANG === "1";
export const grokKillTaskShape = process.env.GOAT_ACP_GROK_KILL_TASK_SHAPE;
export const emitActiveToolThenHang = process.env.GOAT_ACP_EMIT_ACTIVE_TOOL_THEN_HANG === "1";
export const emitGrokMonitorPostTurnPoll =
  process.env.GOAT_ACP_EMIT_GROK_MONITOR_POST_TURN_POLL === "1";
export const emitGrokBackgroundTaskStarted =
  process.env.GOAT_ACP_EMIT_GROK_BACKGROUND_TASK_STARTED === "1";
export const emitGrokBackgroundTaskPoll =
  process.env.GOAT_ACP_GROK_BACKGROUND_TASK_COMPLETION === "poll";
