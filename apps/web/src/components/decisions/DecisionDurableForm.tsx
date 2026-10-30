import type { DecisionItem } from "@goat/client-runtime/state/decision-inbox";
import { useId } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export type DecisionAnswer = { readonly optionId: string; readonly reason: string };
export type DecisionDraft = { readonly optionId: string | null; readonly reason: string };

/** A decision an agent asked for: pick one option, optionally say why; the choice goes back to it. */
export function DecisionDurableForm({
  item,
  draft,
  disabled,
  onChange,
  onSubmit,
}: {
  item: Extract<DecisionItem, { kind: "decision" }>;
  draft: DecisionDraft | undefined;
  disabled: boolean;
  onChange: (draft: DecisionDraft) => void;
  onSubmit: (answer: DecisionAnswer) => Promise<unknown>;
}) {
  const reasonId = useId();
  const { decision } = item;
  const optionId = draft?.optionId ?? decision.recommended;
  const reason = draft?.reason ?? "";
  const setOptionId = (next: string) => onChange({ optionId: next, reason });
  const setReason = (next: string) => onChange({ optionId, reason: next });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && optionId !== null) void onSubmit({ optionId, reason });
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium">{decision.title}</h3>
        {decision.context ? (
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{decision.context}</p>
        ) : null}
      </div>
      <div role="radiogroup" aria-label="Options" className="flex flex-col gap-2">
        {decision.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={optionId === option.id}
            variant={optionId === option.id ? "default" : "outline"}
            disabled={disabled}
            onClick={() => setOptionId(option.id)}
          >
            {option.label}
            {decision.recommended === option.id ? " (recommended)" : ""}
          </Button>
        ))}
      </div>
      {optionId !== null ? (
        <p className="text-sm text-muted-foreground">
          {decision.options.find((option) => option.id === optionId)?.consequence}
        </p>
      ) : null}
      <label htmlFor={reasonId} className="text-sm font-medium">
        Reason (optional)
      </label>
      <Textarea
        id={reasonId}
        value={reason}
        disabled={disabled}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why this choice?"
      />
      <div>
        <Button type="submit" disabled={disabled || optionId === null}>
          Submit decision
        </Button>
      </div>
    </form>
  );
}
