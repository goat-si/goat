import { useAtomValue } from "@effect/atom-react";
import { HUB_NODE_IMPORT_NOTICE } from "@goat/client-runtime/hub-nodes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type {
  AuthMcpClientAccess,
  EnvironmentId,
  HubNode,
  HubNodeNotice,
  HubNodesAddInput,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { HubProxyNodeAccess } from "./HubProxyNodesSettings";
import {
  savedHubNodeProfiles,
  canRemoveHubNode,
  hubNodeLastSeenLabel,
  hubNodeRemovalInput,
  hubNodeRouteLabel,
  hubNodeStatusLabel,
  isHubNodesUnsupportedError,
} from "./HubNodesSettings.logic";

/** The hub's own list of the machines it reaches, and the commands that change it. */
export function useHubNodes(environmentId: EnvironmentId) {
  const listed = useAtomValue(serverEnvironment.hubNodesLive({ environmentId, input: {} }));
  const value = Option.getOrNull(AsyncResult.value(listed));
  const canAdd = useAtomValue(serverEnvironment.addHubNode.permissionAtom(environmentId));
  const canRemove = useAtomValue(serverEnvironment.removeHubNode.permissionAtom(environmentId));
  const canCheck = useAtomValue(serverEnvironment.checkHubNodes.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    serverEnvironment.dismissHubNodeNotice.permissionAtom(environmentId),
  );
  const add = useAtomCommand(serverEnvironment.addHubNode, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeHubNode, { reportFailure: false });
  const check = useAtomCommand(serverEnvironment.checkHubNodes, { reportFailure: false });
  const dismiss = useAtomCommand(serverEnvironment.dismissHubNodeNotice, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const run = async (key: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    if (busy !== null) return false;
    setBusy(key);
    setError(null);
    const result = await action();
    setBusy(null);
    setNow(Date.now());
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "The hub request failed.");
      }
      return false;
    }
    return true;
  };
  const failed = AsyncResult.isFailure(listed);
  return {
    environmentId,
    value,
    failed,
    /** An older hub without a device list: its OpenCodex devices still show. */
    unsupported: failed && isHubNodesUnsupportedError(Cause.squash(listed.cause)),
    loading: value === null && !failed,
    canAdd,
    canRemove,
    canCheck,
    canDismiss,
    busy,
    error,
    now,
    run,
    checkAll: () => run("check-all", () => check({ environmentId, input: {} })),
    check: (node: HubNode) =>
      run(node.nodeId, () => check({ environmentId, input: { nodeId: node.nodeId } })),
    remove: (node: HubNode) =>
      run(`remove:${node.nodeId}`, () =>
        remove({ environmentId, input: hubNodeRemovalInput(node) }),
      ),
    dismiss: (id: HubNodeNotice["id"]) =>
      run("dismiss", () => dismiss({ environmentId, input: { id } })),
    add: (input: HubNodesAddInput, key = input.kind === "linked" ? "add-linked" : "add-ssh") =>
      run(key, () => add({ environmentId, input })),
  };
}

export type HubNodes = ReturnType<typeof useHubNodes>;

/** A node's routes and whether the hub last reached it. */
export function HubNodeStatus({ node, now }: { readonly node: HubNode; readonly now: number }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {node.routes.map((route) => (
        <Badge key={route.routeId} variant="secondary" size="sm">
          {hubNodeRouteLabel(route)}
        </Badge>
      ))}
      <span
        aria-hidden
        className={
          node.status === "online"
            ? "size-1.5 rounded-full bg-success"
            : node.status === "offline"
              ? "size-1.5 rounded-full bg-destructive"
              : "size-1.5 rounded-full bg-muted-foreground"
        }
      />
      <span>
        {hubNodeStatusLabel(node.status)}
        {node.lastSeenAt ? ` · ${hubNodeLastSeenLabel(node.lastSeenAt, now)}` : ""}
      </span>
    </div>
  );
}

export function HubNodeButtons({
  nodes,
  node,
}: {
  readonly nodes: HubNodes;
  readonly node: HubNode;
}) {
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        aria-label={`Check ${node.label}`}
        disabled={!nodes.canCheck || nodes.busy !== null}
        onClick={() => void nodes.check(node)}
      >
        {nodes.busy === node.nodeId ? "Checking…" : "Check"}
      </Button>
      <Button
        size="xs"
        variant="ghost-destructive"
        aria-label={`Remove ${node.label}`}
        disabled={!nodes.canRemove || !canRemoveHubNode(node) || nodes.busy !== null}
        onClick={() => void nodes.remove(node)}
      >
        Remove
      </Button>
    </>
  );
}

/** What a node row shows under its facts: phone access, and where cloud machines are removed. */
export function HubNodeFooter({
  nodes,
  node,
}: {
  readonly nodes: HubNodes;
  readonly node: HubNode;
}) {
  return (
    <>
      {canRemoveHubNode(node) ? null : (
        <p className="text-xs text-muted-foreground">
          Remove cloud machines in Settings → Connections → Cloud machines.
        </p>
      )}
      <HubProxyNodeAccess environmentId={nodes.environmentId} node={node} />
    </>
  );
}

/** Notices, the add forms and the desktop's saved connections, under the device list. */
export function HubNodeAddForms({ nodes }: { readonly nodes: HubNodes }) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [alias, setAlias] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const { value, busy, canAdd } = nodes;
  if (nodes.unsupported) return null;
  const saved =
    window.desktopBridge && value
      ? savedHubNodeProfiles(catalog.entries.values(), value.nodes)
      : [];
  return (
    <div className="space-y-3 px-3 py-3 sm:px-4">
      <p className="text-xs text-muted-foreground">
        This server keeps the list. Every phone or browser paired with it sees the same devices.
      </p>
      {nodes.error !== null || nodes.failed ? (
        <p role="alert" className="text-xs text-destructive">
          {nodes.error ?? "Could not load devices from this hub."}
        </p>
      ) : null}
      {value?.notices.map((notice) => (
        <Alert key={notice.id} variant="warning">
          <AlertDescription>{HUB_NODE_IMPORT_NOTICE}</AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              disabled={!nodes.canDismiss || busy !== null}
              onClick={() => void nodes.dismiss(notice.id)}
            >
              Dismiss
            </Button>
          </AlertAction>
        </Alert>
      ))}
      {!canAdd ? (
        <p className="text-xs text-muted-foreground">
          Adding or removing devices needs permission to change this server's settings.
        </p>
      ) : null}
      {canAdd && value ? (
        <>
          <form
            className="space-y-2 border-t border-border/50 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (
                  await nodes.add({
                    kind: "ssh",
                    alias: alias.trim(),
                    hostname: null,
                    username: null,
                    port: null,
                    ...(label.trim() ? { label: label.trim() } : {}),
                  })
                ) {
                  setAlias("");
                  setLabel("");
                }
              })();
            }}
          >
            <h3 className="text-sm font-medium">Add SSH host</h3>
            <Input
              size="sm"
              aria-label="SSH alias"
              placeholder="SSH alias"
              value={alias}
              maxLength={255}
              disabled={busy !== null}
              onChange={(event) => setAlias(event.target.value)}
            />
            <Input
              size="sm"
              aria-label="Device label (optional)"
              placeholder="Label (optional)"
              value={label}
              maxLength={120}
              disabled={busy !== null}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button size="sm" type="submit" disabled={busy !== null || !alias.trim()}>
              Add SSH host
            </Button>
          </form>
          <form
            className="space-y-2 border-t border-border/50 pt-3"
            onSubmit={(event) => {
              event.preventDefault();
              void (async () => {
                if (
                  await nodes.add({ kind: "linked", url: url.trim(), name: name.trim(), access })
                ) {
                  setUrl("");
                  setName("");
                }
              })();
            }}
          >
            <h3 className="text-sm font-medium">Add GOAT server</h3>
            <Input
              size="sm"
              aria-label="Pairing URL"
              placeholder="Pairing URL"
              autoComplete="off"
              value={url}
              maxLength={2048}
              disabled={busy !== null}
              onChange={(event) => setUrl(event.target.value)}
            />
            <Input
              size="sm"
              aria-label="Server name"
              placeholder="Server name"
              value={name}
              maxLength={63}
              pattern="[a-z0-9._-]+"
              disabled={busy !== null}
              onChange={(event) => setName(event.target.value)}
            />
            <Select
              value={access}
              disabled={busy !== null}
              onValueChange={(next) => {
                if (next === "read-only" || next === "approval-required" || next === "full-access")
                  setAccess(next);
              }}
            >
              <SelectTrigger size="sm" aria-label="Server access">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="read-only">Read-only</SelectItem>
                <SelectItem value="approval-required">Approval required</SelectItem>
                <SelectItem value="full-access">Full access</SelectItem>
              </SelectPopup>
            </Select>
            <Button size="sm" type="submit" disabled={busy !== null || !url.trim() || !name.trim()}>
              Add GOAT server
            </Button>
          </form>
        </>
      ) : null}
      {saved.length > 0 ? (
        <div className="space-y-2 border-t border-border/50 pt-3">
          <h3 className="text-sm font-medium">Saved on this desktop</h3>
          {saved.map((profile, index) => (
            <div
              key={`${profile.environmentId}:${profile.ssh.alias}:${profile.ssh.hostname}:${profile.ssh.username}:${profile.ssh.port}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0 text-sm">
                {profile.label}
                <span className="ml-2 text-xs text-muted-foreground">SSH {profile.ssh.alias}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Add ${profile.label} to hub`}
                disabled={!canAdd || busy !== null}
                onClick={() =>
                  void nodes.add(
                    { kind: "ssh", ...profile.ssh, label: profile.label },
                    `saved:${index}`,
                  )
                }
              >
                Add to hub
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
