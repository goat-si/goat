import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderHostRow,
  ProviderHostSyncDriver,
  ProviderSyncLogin,
  ProviderSyncState,
} from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Radio, RadioGroup } from "../ui/radio-group";
import {
  cancelProviderHostSync,
  readProviderHostSync,
  startProviderHostSync,
} from "./ProviderHostMatrix.commands";
import { providerHostCommandError, useProviderHostMatrix } from "./ProviderHostMatrix.data";
import {
  defaultSyncHosts,
  matchableLocalVersion,
  safeLoginUrl,
  syncHostChoices,
  syncSummary,
  SYNC_PHASE_LABELS,
} from "./ProviderHostMatrix.logic";

function CopyValue({ value, label }: { readonly value: string; readonly label: string }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        aria-label={`Copy ${label}`}
        onClick={() => {
          void writeTextToClipboard(value, label).then(
            () => setMessage("Copied"),
            () => setMessage("Could not copy"),
          );
        }}
      >
        Copy
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {message}
      </span>
    </div>
  );
}

function LoginInstructions({
  login,
  host,
}: {
  readonly login: ProviderSyncLogin;
  readonly host: string;
}) {
  if (login.type === "open_host") return <p>{login.instruction}</p>;
  if (login.type === "terminal")
    return (
      <div className="space-y-2">
        <p className="text-muted-foreground">Run on {host}</p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          <code>{login.command}</code>
        </pre>
        <CopyValue value={login.command} label="sign-in command" />
      </div>
    );
  const url = safeLoginUrl(login.url);
  return (
    <div className="space-y-2">
      {url ? (
        <a
          className="break-all text-primary underline underline-offset-4"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          {login.type === "device_code" ? url : "Open sign-in page"}
        </a>
      ) : (
        <p role="alert">The provider returned an unsupported sign-in link.</p>
      )}
      {login.type === "device_code" ? (
        <>
          <p className="text-muted-foreground">Enter this code on the verification page:</p>
          <code className="block select-all text-2xl font-semibold tracking-widest">
            {login.userCode}
          </code>
          <CopyValue value={login.userCode} label="verification code" />
        </>
      ) : null}
    </div>
  );
}

function SyncForm({
  rows,
  driver,
  initialHosts,
  disabled,
  onStart,
}: {
  readonly rows: ReadonlyArray<ProviderHostRow>;
  readonly driver: ProviderHostSyncDriver;
  readonly initialHosts?: ReadonlyArray<string> | undefined;
  readonly disabled: boolean;
  readonly onStart: (hosts: string[], version: string, login: boolean) => void;
}) {
  const localVersion = matchableLocalVersion(rows, driver);
  const [selected, setSelected] = useState(() => defaultSyncHosts(rows, driver, initialHosts));
  const [version, setVersion] = useState(localVersion ?? "latest");
  const [login, setLogin] = useState(true);
  const choices = syncHostChoices(rows, driver);
  const hosts = selected.filter((host) =>
    choices.some((choice) => choice.host === host && !choice.disabled),
  );
  return (
    <form
      id="provider-host-sync-form"
      className="space-y-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && hosts.length > 0 && hosts.length <= 16) onStart(hosts, version, login);
      }}
    >
      <fieldset disabled={disabled} className="space-y-3">
        <legend className="mb-2 font-medium">Machines</legend>
        {choices.length === 0 ? (
          <p className="text-muted-foreground">
            Connect an SSH host in Connections to sync providers.
          </p>
        ) : null}
        {choices.map((choice) => (
          <label key={choice.host} className="flex items-start gap-3">
            <Checkbox
              checked={hosts.includes(choice.host)}
              disabled={
                disabled || choice.disabled || (!hosts.includes(choice.host) && hosts.length >= 16)
              }
              onCheckedChange={(checked) => {
                setSelected(
                  checked ? [...hosts, choice.host] : hosts.filter((host) => host !== choice.host),
                );
              }}
            />
            <span className="min-w-0 break-words">
              {choice.host}
              {choice.reason ? (
                <span className="block text-xs text-muted-foreground">{choice.reason}</span>
              ) : null}
            </span>
          </label>
        ))}
        {hosts.length >= 16 ? (
          <p className="text-xs text-muted-foreground">Sync up to 16 machines at a time.</p>
        ) : null}
      </fieldset>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="mb-2 font-medium">Version</legend>
        <RadioGroup value={version} onValueChange={(value) => setVersion(String(value))}>
          <label className="flex items-center gap-3">
            <Radio value={localVersion ?? "match"} disabled={disabled || !localVersion} />
            {localVersion
              ? `Match this machine (${localVersion})`
              : "Match this machine (version unavailable)"}
          </label>
          <label className="flex items-center gap-3">
            <Radio value="latest" disabled={disabled} />
            Latest
          </label>
        </RadioGroup>
      </fieldset>
      <label className="flex items-center gap-3">
        <Checkbox checked={login} onCheckedChange={setLogin} disabled={disabled} />
        Sign in after installing
      </label>
      <p className="text-xs text-muted-foreground">
        Each machine runs the provider&apos;s own installer and sign-in. Sign in with your own
        account; GOAT never copies credentials between machines.
      </p>
      <Button type="submit" size="sm" disabled={disabled || hosts.length === 0}>
        Start
      </Button>
    </form>
  );
}

export interface ProviderHostSyncDialogProps {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderHostSyncDriver;
  readonly displayName: string;
  readonly initialHosts?: ReadonlyArray<string> | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onComplete?: (() => void) | undefined;
}

/** Also usable by provider pickers; the dialog reads its own destination environment. */
export function ProviderHostSyncDialog(props: ProviderHostSyncDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <ProviderHostSyncContent {...props} />
    </Dialog>
  );
}

function ProviderHostSyncContent({
  environmentId,
  driver,
  displayName,
  initialHosts,
  onComplete,
}: ProviderHostSyncDialogProps) {
  const matrix = useProviderHostMatrix(environmentId);
  const start = useAtomCommand(startProviderHostSync, { reportFailure: false });
  const status = useAtomCommand(readProviderHostSync, { reportFailure: false });
  const cancel = useAtomCommand(cancelProviderHostSync, { reportFailure: false });
  const canStart = useAtomValue(startProviderHostSync.permissionAtom(environmentId));
  const canCancel = useAtomValue(cancelProviderHostSync.permissionAtom(environmentId));
  const [sync, setSync] = useState<ProviderSyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  const revision = useRef(0);
  const complete = useStableCallback(() => {
    void matrix.refresh();
    onComplete?.();
  });
  const readStatus = useStableCallback((syncId: string) =>
    status({ environmentId, input: { syncId } }),
  );
  const syncId = sync?.syncId;
  const done = sync?.done;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    if (!syncId || done) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const request = revision.current;
      const result = await readStatus(syncId!);
      if (stopped) return;
      if (request === revision.current) {
        setError(providerHostCommandError(result));
        if (result._tag === "Success") {
          setSync(result.value);
          if (result.value.done) {
            complete();
            return;
          }
        }
      }
      timer = setTimeout(() => {
        void poll();
      }, 2_000);
    }
    timer = setTimeout(() => {
      void poll();
    }, 2_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [syncId, done, readStatus, complete]);

  async function startSync(hosts: string[], version: string, login: boolean) {
    if (busy.current || !canStart) return;
    busy.current = true;
    setPending(true);
    setError(null);
    setHandoff(null);
    const result = await start({ environmentId, input: { driver, hosts, version, login } });
    busy.current = false;
    if (!mounted.current) return;
    setPending(false);
    setError(providerHostCommandError(result));
    if (result._tag === "Success") {
      if (result.value.kind === "started") {
        setSync(result.value.sync);
        if (result.value.sync.done) complete();
      } else
        setHandoff(
          `${result.value.handoff.title}. Complete the approval in GOAT, then refresh the machines and try again.`,
        );
    }
  }
  async function cancelSync() {
    if (!sync || busy.current || !canCancel) return;
    busy.current = true;
    revision.current++;
    setPending(true);
    const result = await cancel({ environmentId, input: { syncId: sync.syncId } });
    busy.current = false;
    if (!mounted.current) return;
    revision.current++;
    setPending(false);
    setError(providerHostCommandError(result));
    if (result._tag === "Success") {
      setSync(result.value);
      if (result.value.done) complete();
    }
  }
  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>Sync {displayName}</DialogTitle>
        <DialogDescription>
          Install and sign in on your other machines. Closing this dialog does not cancel a running
          sync.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {!canStart ? (
          <p className="text-sm text-muted-foreground">
            Provider management permission is required to sync machines.
          </p>
        ) : null}
        {error || matrix.error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? matrix.error}
          </p>
        ) : null}
        {handoff ? (
          <p role="status" className="text-sm">
            {handoff}
          </p>
        ) : null}
        {sync ? (
          <div className="space-y-4 text-sm">
            <p role="status">
              {sync.done
                ? syncSummary(sync)
                : "Sync in progress. Complete sign-in for each machine below."}
            </p>
            {sync.hosts.map((host) => (
              <section
                key={host.host ?? "local"}
                className="space-y-2 rounded-md border border-border p-3"
                aria-label={host.host ?? "This machine"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="break-all font-medium">{host.host ?? "This machine"}</span>
                  <Badge
                    variant={
                      host.phase === "failed"
                        ? "error"
                        : host.phase === "signed_in"
                          ? "success"
                          : "secondary"
                    }
                  >
                    {SYNC_PHASE_LABELS[host.phase]}
                  </Badge>
                </div>
                {host.version ? (
                  <p className="text-xs text-muted-foreground">{host.version}</p>
                ) : null}
                {host.message ? (
                  <p className="break-words text-muted-foreground">{host.message}</p>
                ) : null}
                {host.login && !["signed_in", "failed", "cancelled"].includes(host.phase) ? (
                  <LoginInstructions login={host.login} host={host.host ?? "This machine"} />
                ) : null}
              </section>
            ))}
          </div>
        ) : matrix.data ? (
          <SyncForm
            rows={matrix.data.rows}
            driver={driver}
            initialHosts={initialHosts}
            disabled={pending || !canStart}
            onStart={(hosts, version, login) => {
              void startSync(hosts, version, login);
            }}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {matrix.pending ? "Reading machines…" : "Could not read machines."}
          </p>
        )}
        {pending ? (
          <p role="status" className="text-xs text-muted-foreground">
            {sync ? "Cancelling…" : "Starting sync…"}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {sync?.done ? (
          <Button
            size="sm"
            disabled={!canStart || matrix.pending}
            onClick={() => {
              setSync(null);
              setError(null);
              setHandoff(null);
            }}
          >
            Sync again
          </Button>
        ) : null}
        {!sync || sync.done ? (
          <Button
            size="sm"
            variant="outline"
            disabled={matrix.pending}
            onClick={() => {
              void matrix.refresh();
            }}
          >
            Refresh machines
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !canCancel}
            onClick={() => {
              void cancelSync();
            }}
          >
            Cancel sync
          </Button>
        )}
        <DialogClose render={<Button size="sm" variant="ghost" />}>Close</DialogClose>
      </DialogFooter>
    </DialogPopup>
  );
}
