import {
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type ChildSetupPurpose,
  type RuntimeMode,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import {
  type EnvironmentAuth,
  type IssuedBearerSession,
  ServerAuthSessionTokenIssueError,
} from "./EnvironmentAuth.ts";

export interface IssueSessionInput {
  readonly ttl?: Duration.Duration;
  readonly subject?: string;
  /** Issues a Pen member's session, under its own subject and bounds: neither may be given. */
  readonly penMemberNode?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string;
  /** Caps the threads an `mcp-client` session may start or change; see `authenticateMcpClient`. */
  readonly runtimeModeCeiling?: RuntimeMode;
  readonly childSetupPurpose?: ChildSetupPurpose;
}

export const make = Effect.fn("IssuedEnvironmentSession.make")(function* (defaultSubject: string) {
  const sessions = yield* SessionStore.SessionStore;
  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) => {
    const member = input?.penMemberNode;
    const subject =
      member === undefined ? (input?.subject ?? defaultSubject) : `pen-member:${member}`;
    if (
      member !== undefined &&
      (input?.subject !== undefined ||
        input?.runtimeModeCeiling !== undefined ||
        input?.childSetupPurpose !== undefined)
    )
      return Effect.fail(
        new ServerAuthSessionTokenIssueError({
          cause: "A Pen member session takes no other bounds",
        }),
      );
    return input?.subject === PairingGrantStore.DESKTOP_BOOTSTRAP_SUBJECT
      ? Effect.fail(new PairingGrantStore.ReservedAuthSubjectError())
      : HubConnectAccess.isPrivilegedConnect({
            subject: input?.subject ?? "",
            scopes: input?.scopes ?? [],
          })
        ? Effect.fail(
            new ServerAuthSessionTokenIssueError({ cause: "Use coordinated Connect issuance" }),
          )
        : sessions
            .issue({
              ...(member === undefined ? { subject } : { penMemberNode: member }),
              method: "bearer-access-token",
              scopes: input?.scopes ?? AuthStandardClientScopes,
              client: {
                ...(input?.label ? { label: input.label } : {}),
                deviceType: "bot",
              },
              ...(input?.ttl ? { ttl: input.ttl } : {}),
              ...(input?.runtimeModeCeiling
                ? { runtimeModeCeiling: input.runtimeModeCeiling }
                : {}),
              ...(input?.childSetupPurpose ? { childSetupPurpose: input.childSetupPurpose } : {}),
            })
            .pipe(
              Effect.map(
                (issued) =>
                  ({
                    sessionId: issued.sessionId,
                    token: issued.token,
                    method: "bearer-access-token",
                    scopes: issued.scopes,
                    subject,
                    client: issued.client,
                    expiresAt: DateTime.toUtc(issued.expiresAt),
                    ...(issued.childSetupPurpose
                      ? { childSetupPurpose: issued.childSetupPurpose }
                      : {}),
                  }) satisfies IssuedBearerSession,
              ),
              Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
              Effect.withSpan("EnvironmentAuth.issueSession"),
            );
  };

  return issueSession;
});
