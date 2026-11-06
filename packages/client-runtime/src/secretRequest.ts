import {
  normalizeCardDetails,
  isSecretReference,
  isOnePasswordReference,
  type SecretReference,
  SecretProviderId,
  type ServerSettings,
  type CardDetails,
  type OrchestrationV2TurnItem,
  type SecretRequestAnswerInput,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** A `file` request lets the agent's commands read the value, so its card must not promise more. */
export const secretRequestPrivacyNote = (
  item: Pick<SecretRequestItem, "delivery" | "siteOrigin" | "requestKind">,
) =>
  item.siteOrigin && item.requestKind === "card"
    ? `The agent gets only a reference. GOAT fills this card on ${item.siteOrigin}`
    : item.siteOrigin && item.requestKind === "login"
      ? `The agent gets only a reference. GOAT fills this login on ${item.siteOrigin}`
      : item.siteOrigin
        ? `The agent gets only a reference. GOAT types it into a password field on ${item.siteOrigin}`
        : item.delivery === "file"
          ? "Kept out of chat, in a private file this agent's commands can read for 24 hours"
          : "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const SAVED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Saved securely and kept private",
};
const DECLINED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Declined",
};
const ENDED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "ended",
  label: "Request ended",
};
const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };
const PENDING_ELSEWHERE_DISPLAY: SecretRequestDisplay = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
};

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved":
      return SAVED_DISPLAY;
    case "declined":
      return DECLINED_DISPLAY;
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

export function secretRequestProviders(providers: ServerSettings["secretProviders"] | undefined) {
  const isProviderId = Schema.is(SecretProviderId);
  return Object.entries(providers ?? {}).flatMap(([id, provider]) =>
    isProviderId(id) && provider.kind === "one_password" ? [{ id, label: provider.label }] : [],
  );
}

export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId">,
  answer:
    | { readonly type: "save"; readonly secret: string }
    | { readonly type: "reference"; readonly reference: SecretReference }
    | {
        readonly type: "save_login";
        readonly username: string;
        readonly password: string;
        readonly authenticatorSetupKey?: string;
      }
    | ({ readonly type: "save_card" } & CardDetails)
    | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } };
  }
  if (answer.type === "reference") {
    const reference = { ...answer.reference, reference: answer.reference.reference.trim() };
    return isSecretReference(reference) && isOnePasswordReference(reference.reference)
      ? { threadId: item.threadId, turnItemId: item.id, answer: { type: "reference", reference } }
      : null;
  }
  if (answer.type === "save_login") {
    const username = answer.username.trim();
    const password = answer.password;
    const key = answer.authenticatorSetupKey?.trim();
    if (username.length === 0 || password.trim().length === 0) return null;
    return {
      threadId: item.threadId,
      turnItemId: item.id,
      answer: {
        type: "save_login",
        username,
        password,
        ...(key
          ? {
              authenticatorSetupKey: key.toLowerCase().startsWith("otpauth:")
                ? answer.authenticatorSetupKey
                : key,
            }
          : {}),
      },
    };
  }
  if (answer.type === "save_card") {
    const card = normalizeCardDetails(answer);
    if (card === undefined) return null;
    return { threadId: item.threadId, turnItemId: item.id, answer: { ...card, type: "save_card" } };
  }
  const secret = answer.secret.trim();
  if (secret.length === 0) return null;
  return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save", secret } };
}

const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Only known server errors pass their message through: anything else (transport or encoding
 * failures) gets the generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
