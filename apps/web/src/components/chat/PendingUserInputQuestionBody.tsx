import type { ScopedThreadRef, UserInputQuestion } from "@goat/contracts";
import ChatMarkdown from "../ChatMarkdown";
import { CheckIcon } from "../solar";
import { cn } from "../../lib/utils";

export function PendingUserInputQuestionBody({
  question,
  cwd,
  threadRef,
  selectedOptionValues,
  customAnswerActive,
  optimisticOptionValue,
  disabled,
  showShortcuts = false,
  onSelect,
}: {
  question: UserInputQuestion;
  /** Resolves file links in the question text. */
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
  selectedOptionValues: readonly string[];
  customAnswerActive: boolean;
  optimisticOptionValue?: string | undefined;
  disabled: boolean;
  showShortcuts?: boolean;
  onSelect: (questionId: string, optionValue: string) => void;
}) {
  return (
    <>
      <ChatMarkdown
        text={question.question}
        cwd={cwd}
        threadRef={threadRef}
        className="text-foreground/85"
      />
      {question.multiSelect ? (
        <p className="mt-1 text-secondary-label text-xs">Select one or more options.</p>
      ) : null}
      <div className="mt-2.5 flex flex-col gap-1.5">
        {question.options.map((option, index) => {
          const optionValue = option.value ?? option.label;
          const isSelected =
            optimisticOptionValue === optionValue ||
            (!customAnswerActive && selectedOptionValues.includes(optionValue));
          const shortcutKey = showShortcuts && index < 9 ? index + 1 : null;
          return (
            <button
              key={`${question.id}:${optionValue}`}
              type="button"
              disabled={disabled}
              aria-pressed={isSelected}
              onClick={() => onSelect(question.id, optionValue)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
                isSelected
                  ? "border-primary/60 bg-primary/8 text-foreground"
                  : "border-border bg-background text-foreground/85",
                !isSelected && !disabled && "hover:border-foreground/20 hover:bg-accent",
                disabled && "opacity-50 cursor-not-allowed",
                !disabled && "cursor-pointer",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center border transition-colors duration-150",
                  question.multiSelect ? "rounded-xs" : "rounded-full",
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background",
                )}
              >
                {isSelected ? (
                  question.multiSelect ? (
                    <CheckIcon className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-primary-foreground" />
                  )
                ) : null}
              </span>
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-secondary-label text-2xs">{option.description}</span>
                ) : null}
              </div>
              {shortcutKey !== null ? (
                <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
                  {shortcutKey}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
