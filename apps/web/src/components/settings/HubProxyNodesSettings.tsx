import { useAtomValue } from "@effect/atom-react";
import { createHubProxyEnvironmentAtoms } from "@goat/client-runtime/state/hubProxy";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { AuthEnvironmentScope, EnvironmentId, HubNode } from "@goat/contracts";
import { useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  canShowHubProxySettings,
  hubProxyFailureMessage,
  hubProxyNodeActions,
} from "./HubProxyNodesSettings.logic";

const hubProxyEnvironment = createHubProxyEnvironmentAtoms(connectionAtomRuntime);

/**
 * Proxy actions for one row of the hub's device list: set up an SSH machine GOAT never ran on, or
 * let the hub reach a linked machine for paired phones. Shown only on hubs that proxy.
 */
export function HubProxyNodeAccess({
  environmentId,
  node,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: HubNode;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canPrepare = useAtomValue(hubProxyEnvironment.prepareNode.permissionAtom(environmentId));
  const canEnroll = useAtomValue(hubProxyEnvironment.enrollNode.permissionAtom(environmentId));
  const canUnenroll = useAtomValue(hubProxyEnvironment.unenrollNode.permissionAtom(environmentId));
  if (!canShowHubProxySettings(config, canPrepare && canEnroll && canUnenroll)) return null;
  return <HubProxyNodeRow environmentId={environmentId} node={node} />;
}

function HubProxyNodeRow({
  environmentId,
  node,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: HubNode;
}) {
  const prepare = useAtomCommand(hubProxyEnvironment.prepareNode, { reportFailure: false });
  const enroll = useAtomCommand(hubProxyEnvironment.enrollNode, { reportFailure: false });
  const unenroll = useAtomCommand(hubProxyEnvironment.unenrollNode, { reportFailure: false });
  const canPrepare = useAtomValue(hubProxyEnvironment.prepareNode.permissionAtom(environmentId));
  const canEnroll = useAtomValue(hubProxyEnvironment.enrollNode.permissionAtom(environmentId));
  const canUnenroll = useAtomValue(hubProxyEnvironment.unenrollNode.permissionAtom(environmentId));
  const [pairingUrl, setPairingUrl] = useState("");
  const [busy, setBusy] = useState<"prepare" | "enroll" | "unenroll" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<readonly AuthEnvironmentScope[] | null>(null);
  const [removed, setRemoved] = useState(false);
  const actions = hubProxyNodeActions(node);
  const target = { environmentId, input: { nodeId: node.nodeId } };
  const setup = async () => {
    setBusy("prepare");
    setError(null);
    const result = await prepare(target);
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(
        hubProxyFailureMessage(squashAtomCommandFailure(result), "Could not set up this machine."),
      );
  };
  const allow = async () => {
    if (pairingUrl.trim().length === 0) return;
    setBusy("enroll");
    setError(null);
    const result = await enroll({
      ...target,
      input: { nodeId: node.nodeId, pairingUrl: pairingUrl.trim() },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(
          hubProxyFailureMessage(squashAtomCommandFailure(result), "Could not allow phone access."),
        );
      return;
    }
    setPairingUrl("");
    setScopes(result.value.scopes);
    setRemoved(false);
  };
  const remove = async () => {
    setBusy("unenroll");
    setError(null);
    const result = await unenroll(target);
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result))
        setError(
          hubProxyFailureMessage(
            squashAtomCommandFailure(result),
            "Could not remove phone access.",
          ),
        );
      return;
    }
    setScopes(null);
    setRemoved(true);
  };
  return (
    <div className="space-y-2">
      {actions.setup ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Set up installs GOAT on this machine if needed.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!canPrepare || busy !== null}
            onClick={() => void setup()}
          >
            {busy === "prepare" ? "Setting up…" : "Set up"}
          </Button>
        </div>
      ) : null}
      {actions.reachable ? (
        <p className="text-xs text-muted-foreground">Reachable from paired phones</p>
      ) : null}
      {actions.linked ? (
        <div className="space-y-2">
          <Input
            size="sm"
            type="password"
            autoComplete="off"
            aria-label={`Pairing link from ${node.label}`}
            placeholder="Pairing link from this machine"
            value={pairingUrl}
            disabled={!canEnroll || busy !== null}
            onChange={(event) => setPairingUrl(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canEnroll || busy !== null || pairingUrl.trim().length === 0}
              onClick={() => void allow()}
            >
              {busy === "enroll" ? "Allowing…" : "Allow phone access"}
            </Button>
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={!canUnenroll || busy !== null}
              onClick={() => void remove()}
            >
              {busy === "unenroll" ? "Removing…" : "Remove phone access"}
            </Button>
          </div>
          {scopes !== null ? (
            <p role="status" className="text-xs text-muted-foreground">
              Granted scopes: {scopes.length > 0 ? scopes.join(", ") : "None"}
            </p>
          ) : null}
          {removed ? (
            <p role="status" className="text-xs text-muted-foreground">
              Linked phone access removed.
            </p>
          ) : null}
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
