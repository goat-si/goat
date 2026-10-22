import { useAtomValue } from "@effect/atom-react";
import { HUB_NODE_IMPORT_NOTICE } from "@goat/client-runtime/hub-nodes";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";
import type { AuthMcpClientAccess, EnvironmentId } from "@goat/contracts";
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
import { FoldedSettingsSection } from "./FoldedSettingsSection";
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

export function HubNodesSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const listed = useAtomValue(serverEnvironment.hubNodesLive({ environmentId, input: {} }));
  const value = Option.getOrNull(AsyncResult.value(listed));
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
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
  const [alias, setAlias] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<AuthMcpClientAccess>("approval-required");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const saved =
    window.desktopBridge && value
      ? savedHubNodeProfiles(catalog.entries.values(), value.nodes)
      : [];
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
  if (AsyncResult.isFailure(listed) && isHubNodesUnsupportedError(Cause.squash(listed.cause)))
    return null;
  return (
    <FoldedSettingsSection
      id="hub-nodes"
      title="Devices on this hub"
      summary={value ? `${value.nodes.length} devices` : null}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!canCheck || busy !== null || value === null}
          onClick={() => void run("check-all", () => check({ environmentId, input: {} }))}
        >
          {busy === "check-all" ? "Checking…" : "Check all"}
        </Button>
      }
    >
      <div className="space-y-3 px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          This server keeps the list. Every phone or browser paired with it sees the same devices.
        </p>
        {error !== null || AsyncResult.isFailure(listed) ? (
          <p role="alert" className="text-xs text-destructive">
            {error ?? "Could not load devices from this hub."}
          </p>
        ) : null}
        {value === null && !AsyncResult.isFailure(listed) ? (
          <p className="text-xs text-muted-foreground">Loading devices…</p>
        ) : null}
        {value?.notices.map((notice) => (
          <Alert key={notice.id} variant="warning">
            <AlertDescription>{HUB_NODE_IMPORT_NOTICE}</AlertDescription>
            <AlertAction>
              <Button
                size="sm"
                variant="outline"
                disabled={!canDismiss || busy !== null}
                onClick={() =>
                  void run("dismiss", () => dismiss({ environmentId, input: { id: notice.id } }))
                }
              >
                Dismiss
              </Button>
            </AlertAction>
          </Alert>
        ))}
        {value?.nodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices added yet.</p>
        ) : null}
        {value?.nodes.map((node) => (
          <div
            key={node.nodeId}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 py-3"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-words text-sm font-medium">{node.label}</p>
              <div className="flex flex-wrap gap-1">
                {node.routes.map((route) => (
                  <Badge key={route.routeId} variant="secondary" size="sm">
                    {hubNodeRouteLabel(route)}
                  </Badge>
                ))}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
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
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                aria-label={`Check ${node.label}`}
                disabled={!canCheck || busy !== null}
                onClick={() =>
                  void run(node.nodeId, () =>
                    check({ environmentId, input: { nodeId: node.nodeId } }),
                  )
                }
              >
                {busy === node.nodeId ? "Checking…" : "Check"}
              </Button>
              <div>
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${node.label}`}
                  disabled={!canRemove || !canRemoveHubNode(node) || busy !== null}
                  onClick={() =>
                    void run(`remove:${node.nodeId}`, () =>
                      remove({ environmentId, input: hubNodeRemovalInput(node) }),
                    )
                  }
                >
                  Remove
                </Button>
              </div>
              {!canRemoveHubNode(node) ? (
                <span className="text-xs text-muted-foreground">Manage cloud machines below</span>
              ) : null}
            </div>
            <div className="basis-full">
              <HubProxyNodeAccess environmentId={environmentId} node={node} />
            </div>
          </div>
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
                    await run("add-ssh", () =>
                      add({
                        environmentId,
                        input: {
                          kind: "ssh",
                          alias: alias.trim(),
                          hostname: null,
                          username: null,
                          port: null,
                          ...(label.trim() ? { label: label.trim() } : {}),
                        },
                      }),
                    )
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
                    await run("add-linked", () =>
                      add({
                        environmentId,
                        input: { kind: "linked", url: url.trim(), name: name.trim(), access },
                      }),
                    )
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
                onValueChange={(value) => {
                  if (
                    value === "read-only" ||
                    value === "approval-required" ||
                    value === "full-access"
                  )
                    setAccess(value);
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
              <Button
                size="sm"
                type="submit"
                disabled={busy !== null || !url.trim() || !name.trim()}
              >
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
                  <span className="ml-2 text-xs text-muted-foreground">
                    SSH {profile.ssh.alias}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Add ${profile.label} to hub`}
                  disabled={!canAdd || busy !== null}
                  onClick={() =>
                    void run(`saved:${index}`, () =>
                      add({
                        environmentId,
                        input: { kind: "ssh", ...profile.ssh, label: profile.label },
                      }),
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
    </FoldedSettingsSection>
  );
}
