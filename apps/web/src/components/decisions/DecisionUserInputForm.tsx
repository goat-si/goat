import { useId } from "react";
import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { seedUserInputDraftAnswers } from "@goat/client-runtime/state/thread-requests";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@goat/client-runtime/state/user-input-draft";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PendingUserInputQuestionBody } from "../chat/PendingUserInputQuestionBody";

type QuestionDrafts = Record<string, PendingUserInputDraftAnswer>;

export function DecisionUserInputForm({
  item,
  drafts,
  disabled,
  onChange,
  onSubmit,
}: {
  item: Extract<DecisionItem, { kind: "user_input" }>;
  drafts: QuestionDrafts;
  disabled: boolean;
  onChange: (drafts: QuestionDrafts) => void;
  onSubmit: (answers: Record<string, string | string[]>) => Promise<unknown>;
}) {
  const fieldId = useId();
  const seeded: QuestionDrafts = seedUserInputDraftAnswers(item.request.questions, drafts);
  const answers = buildPendingUserInputAnswers(item.request.questions, seeded);
  if (item.request.questions.length === 0) {
    return <p role="status">This request has no questions. Open the thread to continue.</p>;
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && answers !== null) void onSubmit(answers);
      }}
    >
      <div className="flex flex-col gap-6">
        {item.request.questions.map((question, index) => {
          const draft = seeded[question.id];
          const inputId = `${fieldId}-${index}`;
          return (
            <section key={question.id} aria-label={question.header} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{question.header}</h3>
              <PendingUserInputQuestionBody
                question={question}
                cwd={undefined}
                threadRef={item.ref}
                selectedOptionValues={draft?.selectedOptionValues ?? []}
                customAnswerActive={
                  question.initialAnswer !== undefined
                    ? (draft?.customAnswer ?? "").length > 0
                    : (draft?.customAnswer ?? "").trim().length > 0
                }
                disabled={disabled}
                onSelect={(_, value) =>
                  onChange({
                    ...seeded,
                    [question.id]: togglePendingUserInputOptionSelection(question, draft, value),
                  })
                }
              />
              {question.allowCustomAnswer !== false ? (
                <div>
                  <label htmlFor={inputId} className="text-xs text-muted-foreground">
                    {question.options.length > 0 ? "Or write your own answer" : "Your answer"}
                  </label>
                  <Textarea
                    id={inputId}
                    value={draft?.customAnswer ?? ""}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange({
                        ...seeded,
                        [question.id]: setPendingUserInputCustomAnswer(
                          draft,
                          event.target.value,
                          question,
                        ),
                      })
                    }
                  />
                </div>
              ) : null}
            </section>
          );
        })}
        <div>
          <Button type="submit" disabled={disabled || answers === null}>
            Submit answer
          </Button>
        </div>
      </div>
    </form>
  );
}
