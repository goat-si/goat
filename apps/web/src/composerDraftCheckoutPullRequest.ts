/** A pull request a draft was checked out for, linked to the thread the draft's first send makes. */
export interface DraftCheckoutPullRequest {
  readonly url: string;
  readonly branch: string;
}

/** Longer than any host's pull request URL or git branch name; anything longer is not one. */
const MAX_CHECKOUT_FIELD_LENGTH = 4096;

const isCheckoutField = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_CHECKOUT_FIELD_LENGTH;

/**
 * Reads the stored value leniently: storage holds it as an unknown so one malformed draft cannot
 * fail the strict whole-storage read the attachment check relies on. Anything but two strings
 * within the limit is dropped, and the draft hydrates without the link.
 */
function readStoredCheckoutPullRequest(value: unknown): DraftCheckoutPullRequest | null {
  if (!value || typeof value !== "object") return null;
  const { url, branch } = value as Record<string, unknown>;
  return isCheckoutField(url) && isCheckoutField(branch) ? { url, branch } : null;
}

type CheckoutField = { checkoutPullRequest?: DraftCheckoutPullRequest };
const fieldOf = (value: DraftCheckoutPullRequest | null | undefined): CheckoutField =>
  value ? { checkoutPullRequest: value } : {};

/** The draft field read from storage: present only for a valid stored value. */
export const storedCheckoutField = (value: unknown) =>
  fieldOf(readStoredCheckoutPullRequest(value));

/** The draft field after an update, present only when set. */
export const resolvedCheckoutField = (...args: Parameters<typeof resolveCheckoutPullRequest>) =>
  fieldOf(resolveCheckoutPullRequest(...args));

type WithCheckout = { readonly checkoutPullRequest?: DraftCheckoutPullRequest | undefined };
export const sameCheckoutPullRequest = (left: WithCheckout, right: WithCheckout) =>
  checkoutPullRequestsEqual(left.checkoutPullRequest, right.checkoutPullRequest);

/** An explicit value wins; otherwise a checkout's pull request stays with its project. */
export function resolveCheckoutPullRequest(
  existing: { readonly checkoutPullRequest?: DraftCheckoutPullRequest } | undefined,
  explicit: DraftCheckoutPullRequest | null | undefined,
  projectChanged: boolean,
): DraftCheckoutPullRequest | undefined {
  if (explicit !== undefined) return explicit ?? undefined;
  return projectChanged ? undefined : existing?.checkoutPullRequest;
}

function checkoutPullRequestsEqual(
  left: DraftCheckoutPullRequest | undefined,
  right: DraftCheckoutPullRequest | undefined,
): boolean {
  return left === right || (left?.url === right?.url && left?.branch === right?.branch);
}

/**
 * The pull request to link when this draft becomes a thread. Matching the branch at send time,
 * rather than clearing on every branch write, matters: right after a local checkout the live
 * branch sync briefly writes the stale pre-checkout branch back onto the draft before the fresh
 * git status lands.
 */
export function checkoutPullRequestUrlToLink(
  draft:
    | {
        readonly branch: string | null;
        readonly checkoutPullRequest?: DraftCheckoutPullRequest | undefined;
      }
    | null
    | undefined,
): string | null {
  const checkout = draft?.checkoutPullRequest;
  return checkout && draft.branch === checkout.branch ? checkout.url : null;
}
