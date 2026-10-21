import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { DecisionAnswerInput, DecisionItem, EnvironmentId } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

export function DecisionInboxSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const [includeClosed, setIncludeClosed] = useState(false);
  return (
    <SettingsPageContainer>
      <SettingsSection
        id="decision-inbox"
        title="Decision inbox"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            aria-pressed={includeClosed}
            onClick={() => setIncludeClosed(!includeClosed)}
          >
            {includeClosed ? "Show open only" : "Show answered and expired"}
          </Button>
        }
      >
        {connectedEnvironments.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to view decisions.
          </p>
        ) : (
          connectedEnvironments.map((environment) => (
            <EnvironmentDecisions
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              includeClosed={includeClosed}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentDecisions({
  environmentId,
  label,
  includeClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly includeClosed: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.decisionItems({
      environmentId,
      input: { limit: 100, ...(includeClosed ? {} : { status: "open" as const }) },
    }),
  );
  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button size="xs" variant="ghost" onClick={query.refresh} disabled={query.isPending}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {!query.data ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">
          {query.error ? "Could not load decisions. Try Refresh." : "Loading decisions…"}
        </p>
      ) : query.data.items.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-muted-foreground">
          {includeClosed ? "No decisions yet." : "No open decisions."}
        </p>
      ) : (
        <ul className="divide-y divide-border/50">
          {query.data.items.map((item) => (
            <DecisionRow
              key={item.id}
              item={item}
              environmentId={environmentId}
              onAnswered={query.refresh}
            />
          ))}
        </ul>
      )}
      {query.data?.items.length === 100 ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Showing the most recent 100 decisions.
        </p>
      ) : null}
    </div>
  );
}

function DecisionRow({
  item,
  environmentId,
  onAnswered,
}: {
  readonly item: DecisionItem;
  readonly environmentId: EnvironmentId;
  readonly onAnswered: () => void;
}) {
  const allowed = useAtomValue(serverEnvironment.answerDecision.permissionAtom(environmentId));
  const answer = useAtomCommand(serverEnvironment.answerDecision, { reportFailure: false });
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = item.pending?.questions.length === 1 ? item.pending.questions[0] : undefined;
  const simpleQuestion =
    question && !question.multiSelect && question.options.length > 0 && question.options.length <= 8
      ? question
      : undefined;
  const canAnswer =
    item.source === "decision" ||
    item.pending?.approval !== undefined ||
    simpleQuestion !== undefined;
  const threadId = item.from.threadId ?? item.pending?.threadId;
  const submit = async (input: Omit<DecisionAnswerInput, "id" | "reason">) => {
    if (saving || !allowed || !reason.trim()) return;
    setSaving(true);
    setError(null);
    const result = await answer({
      environmentId,
      input: { ...input, id: item.id, reason: reason.trim() },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : String(failure));
      return;
    }
    onAnswered();
  };
  const disabled = saving || !allowed || !reason.trim();
  const reasonId = `decision-reason-${environmentId}-${item.id}`;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium">{item.title}</h4>
        <span className="text-xs capitalize text-muted-foreground">{item.status}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
        {item.context}
      </p>
      <p className="text-xs text-muted-foreground">
        {item.requiredProfile}
        {item.humanRequired ? " · Human response required" : ""}
        {item.from.host ? ` · ${item.from.host}` : ""}
        {item.expiresAt ? ` · Expires ${new Date(item.expiresAt).toLocaleString()}` : ""}
      </p>
      {item.status !== "open" ? (
        item.answer ? (
          <p className="text-sm">
            Answered:{" "}
            {item.options.find((option) => option.id === item.answer)?.label ?? item.answer}
            {item.answeredBy ? ` · ${item.answeredBy}` : ""}
          </p>
        ) : null
      ) : canAnswer ? (
        <>
          {simpleQuestion ? <p className="text-sm">{simpleQuestion.question}</p> : null}
          <div className="space-y-1">
            <label htmlFor={reasonId} className="text-xs text-muted-foreground">
              Reason for your answer
            </label>
            <Input
              id={reasonId}
              value={reason}
              maxLength={2000}
              disabled={saving || !allowed}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Explain your choice"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {item.pending?.approval ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void submit({ decision: "accept" })}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void submit({ decision: "decline" })}
                >
                  Decline
                </Button>
              </>
            ) : simpleQuestion ? (
              simpleQuestion.options.map((option) => (
                <div key={option.value ?? option.label} className="space-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void submit({
                        answers: { [simpleQuestion.id]: option.value ?? option.label },
                      })
                    }
                  >
                    {option.label}
                  </Button>
                  <p className="max-w-sm text-xs text-muted-foreground">{option.description}</p>
                </div>
              ))
            ) : (
              item.options.map((option) => (
                <div key={option.id} className="space-y-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => void submit({ optionId: option.id })}
                  >
                    {option.label}
                    {item.recommended === option.id ? " (recommended)" : ""}
                  </Button>
                  {option.consequence ? (
                    <p className="max-w-sm text-xs text-muted-foreground">{option.consequence}</p>
                  ) : null}
                </div>
              ))
            )}
          </div>
          {!allowed ? (
            <p className="text-xs text-muted-foreground">
              This connection cannot answer decisions.
            </p>
          ) : null}
          {saving ? (
            <p role="status" className="text-xs text-muted-foreground">
              Saving answer…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Answer this request in its thread.</p>
      )}
      {threadId ? (
        <Button
          size="xs"
          variant="ghost"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
            />
          }
        >
          Open asking thread
        </Button>
      ) : null}
    </li>
  );
}
