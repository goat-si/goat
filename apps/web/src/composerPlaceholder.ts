export const DEFAULT_COMPOSER_PLACEHOLDER = "Ask anything. @ files, $ skills, / commands";

export function composerPlaceholder(state: {
  readonly approval: { readonly supportsFeedback?: boolean } | null;
  readonly question: {
    readonly allowCustomAnswer?: boolean | undefined;
    readonly options: ReadonlyArray<unknown>;
  } | null;
  readonly planFollowUp: boolean;
  readonly projectSelectionRequired: boolean;
  readonly showProviderUnavailable: boolean;
}): string {
  if (state.approval) {
    return state.approval.supportsFeedback
      ? "Send feedback to decline this request"
      : "Send a message to decline and redirect the agent";
  }
  if (state.question) {
    return state.question.allowCustomAnswer === false
      ? "Choose an option above"
      : state.question.options.length === 0
        ? "Type your answer"
        : "Type your own answer, or leave this blank to use the selected option";
  }
  if (state.planFollowUp) {
    return "Add feedback to refine the plan, or leave this blank to implement it";
  }
  if (state.projectSelectionRequired) return "Choose a project above to start a thread";
  if (state.showProviderUnavailable) return "Enable a provider in Settings to send a message";
  return DEFAULT_COMPOSER_PLACEHOLDER;
}
