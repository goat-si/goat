import { useAtomValue } from "@effect/atom-react";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  type SecretRequestItem,
} from "@goat/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "~/components/solar";
import { useId, useRef, useState, type CSSProperties, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkLogRow } from "./WorkLog";

const EMPTY_CARD = { number: "", expiryMonth: "", expiryYear: "", cvc: "", name: "" };
const CARD_FIELDS = [
  ["number", "Card number"],
  ["expiryMonth", "Expiry month"],
  ["expiryYear", "Expiry year"],
  ["cvc", "CVC"],
  ["name", "Name on card"],
] as const;

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const canAnswer = useAtomValue(
    serverEnvironment.answerSecretRequest.permissionAtom(props.environmentId),
  );
  const open = useAtomCommand(serverEnvironment.openHandoff, {
    label: "open secret handoff",
    reportFailure: false,
    reportDefect: false,
  });
  const opened = useRef(false);
  const markOpened = () => {
    if (!opened.current && item.handoff?.state === "pending" && canAnswer) {
      opened.current = true;
      void open({
        environmentId: props.environmentId,
        input: { threadId: item.threadId, handoffId: item.id },
      });
    }
  };
  const inputId = useId();
  const passwordId = useId();
  const setupKeyId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [setupKey, setSetupKey] = useState("");
  const [cardValues, setCardValues] = useState(EMPTY_CARD);
  const login = item.requestKind === "login";
  const card = item.requestKind === "card";
  const cardReply = { type: "save_card" as const, ...cardValues };
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);

  const send = async (reply: Parameters<typeof secretRequestAnswerInput>[1]) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      setUsername("");
      setSetupKey("");
      setCardValues(EMPTY_CARD);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send(
      card
        ? cardReply
        : login
          ? { type: "save_login", username, password: secret, authenticatorSetupKey: setupKey }
          : { type: "save", secret },
    );
  };

  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      onFocusCapture={markOpened}
      autoComplete="off"
      // On click, not pointerdown: the mousedown that follows a pointerdown
      // moves focus back off the input. A click that ends a text selection
      // leaves it alone so the reason can still be copied.
      onClick={(event) => {
        if (!(event.target instanceof Element)) return;
        if (event.target.closest("input, button, a")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {login || card ? (
          <div className="text-sm font-medium text-foreground">{item.label}</div>
        ) : (
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            {item.label}
          </label>
        )}
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      {card ? (
        <div className="flex min-w-0 flex-col gap-2">
          {CARD_FIELDS.map(([key, label]) => {
            const id = key === "number" ? inputId : `${inputId}-${key}`;
            return (
              <div key={key} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={id} className="text-sm text-foreground">
                  {label}
                </label>
                <Input
                  id={id}
                  type="text"
                  style={
                    key === "cvc" ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined
                  }
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  value={cardValues[key]}
                  disabled={!canAnswer || submitting}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setCardValues((previous) => ({ ...previous, [key]: value }));
                  }}
                />
              </div>
            );
          })}
          <Button
            type="submit"
            disabled={
              !canAnswer || submitting || secretRequestAnswerInput(item, cardReply) === null
            }
          >
            Save securely
          </Button>
        </div>
      ) : login ? (
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={inputId} className="text-sm text-foreground">
            Username
          </label>
          <Input
            id={inputId}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            value={username}
            disabled={!canAnswer || submitting}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
          <label htmlFor={passwordId} className="text-sm text-foreground">
            Password
          </label>
          <Input
            id={passwordId}
            // A password field would offer to save this login under GOAT's own site.
            type="text"
            className="[-webkit-text-security:disc]"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            value={secret}
            disabled={!canAnswer || submitting}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
          <label htmlFor={setupKeyId} className="text-sm text-foreground">
            Authenticator setup key (optional)
          </label>
          <Input
            id={setupKeyId}
            type="text"
            style={{ WebkitTextSecurity: "disc" } as CSSProperties}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            value={setupKey}
            disabled={!canAnswer || submitting}
            onChange={(event) => setSetupKey(event.currentTarget.value)}
          />
          <Button
            type="submit"
            disabled={
              !canAnswer || submitting || username.trim().length === 0 || secret.trim().length === 0
            }
          >
            Save securely
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <Input
              id={inputId}
              // Password fields prompt to save credentials; this secret is not a login.
              type="text"
              className="[-webkit-text-security:disc]"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
              value={secret}
              disabled={!canAnswer || submitting}
              aria-invalid={error !== null || undefined}
              aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
              onChange={(event) => setSecret(event.currentTarget.value)}
            />
          </div>
          <Button type="submit" disabled={!canAnswer || submitting || secret.trim().length === 0}>
            Save securely
          </Button>
        </div>
      )}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={!canAnswer || submitting}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}
