import { useAuth, useClerk } from "@clerk/react";
import { readConnectAuthorizeRequest } from "@goat/shared/connectAuth";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { navigateConnectCliToOAuth, connectCliSignInRedirectUrl } from "../../cloud/connectCliAuth";
import { useConnectSensitiveAction } from "../../cloud/useConnectReverification";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import {
  CliLinkApprovalResponse,
  RelayAuthenticationStrengthError,
} from "@goat/contracts/connectAssurance";
import * as Schema from "effect/Schema";
import { isElectron } from "../../env";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { resolveClerkSignInProps } from "../clerk/authRedirect";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-3xs font-semibold tracking-widest text-primary uppercase">{eyebrow}</p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

const invalidLinkMessage = {
  eyebrow: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `goat connect` in your terminal and open the freshly printed URL.",
} as const;

const decodeStrengthError = Schema.decodeUnknownOption(RelayAuthenticationStrengthError);
const decodeApprovalResponse = Schema.decodeUnknownSync(CliLinkApprovalResponse);

export function ConnectCliAuthorizeSurface() {
  const [request] = useState(() => readConnectAuthorizeRequest(new URL(window.location.href)));
  const clerk = useClerk();
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const runSensitiveAction = useConnectSensitiveAction();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signInOpened = useRef(false);
  const redirecting = useRef(false);

  const openSignIn = () => {
    if (!request) {
      return;
    }
    clerk.openSignIn(
      resolveClerkSignInProps(
        connectCliSignInRedirectUrl(request, window.location.href),
        isElectron,
      ),
    );
  };
  const openSignInOnLoad = useEffectEvent(openSignIn);

  useEffect(() => {
    if (!request?.approval || !isLoaded || redirecting.current) {
      return;
    }
    if (!isSignedIn) {
      if (!signInOpened.current) {
        signInOpened.current = true;
        openSignInOnLoad();
      }
      return;
    }
  }, [isLoaded, isSignedIn, request]);

  if (!request?.approval) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  const approve = async () => {
    if (pending || !request.approval) return;
    setPending(true);
    setError(null);
    try {
      const approval = await runSensitiveAction(async () => {
        const token = await getToken(resolveRelayClerkTokenOptions());
        const relay = resolveCloudPublicConfig().relayUrl;
        if (!token || !relay) throw new Error("Sign in with MFA to continue.");
        const response = await fetch(`${relay}/v1/client/cli-link-approvals`, {
          method: "POST",
          credentials: "omit",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request.approval),
        });
        if (!response.ok) {
          const error = decodeStrengthError(await response.json());
          if (error._tag === "Some") throw error.value;
          throw new Error(
            "GOAT Connect could not approve this request. Sign in with MFA and retry.",
          );
        }
        return decodeApprovalResponse(await response.json());
      });
      const delivered = await fetch(`http://127.0.0.1:${request.loopbackPort}/approval`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ ...approval, state: request.state }),
      });
      if (!delivered.ok) {
        setError("The terminal did not accept this approval. Re-run goat connect.");
        setPending(false);
        return;
      }
      redirecting.current = true;
      navigateConnectCliToOAuth(request);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authorization was cancelled.");
      setPending(false);
    }
  };
  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Browser authorization"
        title="Approve this computer"
        description="Verify both factors to link this computer to your GOAT Connect account. Remote access becomes available after the terminal completes authorization."
      />
      <p className="mt-4 text-sm text-muted-foreground">
        Account:{" "}
        {clerk.user?.primaryEmailAddress?.emailAddress ??
          clerk.user?.username ??
          "Signed-in account"}
      </p>
      <p className="mt-2 break-all text-sm text-muted-foreground">
        Computer: {request.approval.intent.environmentId}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        {request.approval.intent.managedTunnelsEnabled
          ? "Managed remote access"
          : "Account link without a managed tunnel"}{" "}
        · Notifications and Live Activities unavailable in beta.
      </p>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-6">
        {isLoaded && isSignedIn ? (
          <Button type="button" disabled={pending} onClick={() => void approve()}>
            {pending ? "Waiting for verification…" : "Verify and approve"}
          </Button>
        ) : (
          <Button type="button" disabled={!isLoaded} onClick={openSignIn}>
            Sign in
          </Button>
        )}
      </div>
    </AuthSurfaceShell>
  );
}
