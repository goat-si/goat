import type {
  ComputerUseCallAdmission,
  ComputerUseCallReservation,
  ComputerUseForegroundGrant,
  TurnItemId,
} from "@goat/contracts";
import { requiresForeground } from "./ComputerUseCallReservations.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";
import { reservationRefusal, scopeMessage } from "./ComputerUseLeaseMessages.ts";
import { approvedApps, scopeVerdict, type ListedApp } from "./ComputerUseScope.ts";

type Permissions = NonNullable<
  Extract<ComputerUseCallAdmission, { status: "admitted" }>["permissions"]
>;

export const allowsForegroundCall = (
  call: Extract<ComputerUseCallReservation, { action: "reserve" }>,
  grants: ReadonlyArray<ComputerUseForegroundGrant> | undefined,
  now: number,
  bound: (id: TurnItemId) => boolean,
) => {
  if (!requiresForeground(call) && call.foregroundGrantId === undefined) return true;
  const id = call.foregroundGrantId;
  return (
    id !== undefined &&
    bound(id) &&
    grants?.some((grant) => grant.handoffId === id && grant.expiresAtMillis > now) === true
  );
};

export const withCallPermissions = (
  decision: ComputerUseCallAdmission,
  state: { readonly apps: ReadonlyArray<string> | undefined; readonly wakeAt: number },
): ComputerUseCallAdmission =>
  decision.status === "admitted"
    ? {
        ...decision,
        permissions: {
          ...(state.apps === undefined ? {} : { apps: state.apps }),
          validUntilMillis: state.wakeAt,
        },
      }
    : decision;

/** A delayed reply judges only its call; it must not overwrite a newer streamed scope. */
const admissionScopeRefusal = (
  id: JsonRpcId,
  message: Envelope,
  permissions: Permissions | undefined,
  listed: ReadonlyMap<number, ListedApp>,
  bundleIds: boolean,
) => {
  if (permissions === undefined) return undefined;
  const verdict = scopeVerdict({
    name: message.params?.name,
    args: message.params?.arguments,
    apps: approvedApps(permissions.apps),
    appOf: (pid) => listed.get(pid),
    bundleIds,
  });
  if (verdict._tag === "allow") return undefined;
  const reason = verdict._tag === "refuse" ? verdict.reason : "app_not_approved";
  const app = verdict._tag === "refuse" ? verdict.app : undefined;
  return refusal(
    id,
    message.method,
    reason,
    verdict._tag === "resolve"
      ? "The approved apps changed. Call list_apps to identify the target, then observe again before retrying. This call did not run."
      : scopeMessage(verdict.reason, verdict.app, verdict.opaque, verdict.launch),
    app,
  );
};

/** Confirmation cannot replace a ticket or omit the current scope that justified it. */
export const proxyCallAdmission = (
  id: JsonRpcId,
  message: Envelope,
  decision: ComputerUseCallAdmission,
  listed: ReadonlyMap<number, ListedApp>,
  bundleIds: boolean,
  expectedTicket?: string,
) => {
  if (
    decision.status !== "admitted" ||
    (expectedTicket !== undefined &&
      (decision.reservationId !== expectedTicket || decision.permissions === undefined))
  ) {
    const detail = decision.status === "refused" ? decision.detail : "unauthorized";
    const holder = decision.status === "refused" ? decision.holderThreadId : undefined;
    const app = decision.status === "refused" ? decision.app : undefined;
    return {
      refused: refusal(
        id,
        message.method,
        detail,
        reservationRefusal(detail, holder, app),
        app,
        holder,
      ),
      reservationId: undefined,
      deadline: Infinity,
    };
  }
  return {
    refused: admissionScopeRefusal(id, message, decision.permissions, listed, bundleIds),
    reservationId: decision.reservationId ?? undefined,
    deadline: decision.permissions?.validUntilMillis ?? Infinity,
  };
};
