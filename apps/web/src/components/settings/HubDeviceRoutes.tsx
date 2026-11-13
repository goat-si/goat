import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, HubDeviceRoutesChange, HubDeviceRoutesResult } from "@goat/contracts";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * The SSH routes the Home tries for one Remote Link Child, read when a person opens them. A
 * person's change runs at once; the Home stores a new route only after it proved the link's key.
 */
export function HubDeviceRoutes({
  environmentId,
  alias,
}: {
  readonly environmentId: EnvironmentId;
  readonly alias: string;
}) {
  const canRead = useAtomValue(serverEnvironment.listHubDeviceRoutes.permissionAtom(environmentId));
  const canChange = useAtomValue(
    serverEnvironment.updateHubDeviceRoutes.permissionAtom(environmentId),
  );
  const list = useAtomCommand(serverEnvironment.listHubDeviceRoutes, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateHubDeviceRoutes, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [routes, setRoutes] = useState<{ pin: string; routes: ReadonlyArray<string> } | null>(null);
  const [answer, setAnswer] = useState<HubDeviceRoutesResult | null>(null);
  const [draft, setDraft] = useState("");

  /** keepAnswer: a read-back after a change updates the list and leaves the change's notice. */
  const settle = (result: Awaited<ReturnType<typeof list>>, keepAnswer = false) => {
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setAnswer({
        deviceAlias: alias,
        state: "failed",
        message: failure instanceof Error ? failure.message : String(failure),
      });
      return;
    }
    if (!keepAnswer) setAnswer(result.value);
    if (result.value.pin !== undefined && result.value.routes !== undefined)
      setRoutes({ pin: result.value.pin, routes: result.value.routes });
  };
  const read = async () => {
    setBusy(true);
    settle(await list({ environmentId, input: { deviceAlias: alias } }));
    setBusy(false);
  };
  const change = async (next: HubDeviceRoutesChange) => {
    setBusy(true);
    const result = await update({ environmentId, input: { deviceAlias: alias, change: next } });
    settle(result);
    // A stored change that the Home could not apply yet still lists, so read it back.
    if (
      result._tag === "Success" &&
      result.value.state === "ok" &&
      result.value.routes === undefined
    )
      settle(await list({ environmentId, input: { deviceAlias: alias } }), true);
    setBusy(false);
  };
  const move = (from: number, to: number) => {
    if (routes === null) return;
    const order = [...routes.routes];
    const [moved] = order.splice(from, 1);
    if (moved === undefined) return;
    order.splice(to, 0, moved);
    void change({ op: "order", routes: order });
  };

  if (!open)
    return (
      <Button
        size="xs"
        variant="outline"
        disabled={!canRead}
        onClick={() => {
          setOpen(true);
          void read();
        }}
      >
        Routes
      </Button>
    );
  return (
    <section aria-label={`Routes of ${alias}`} className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">SSH routes, tried in order</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {routes === null ? null : (
        <ol className="space-y-1">
          {routes.routes.map((route, index) => (
            <li key={route} className="flex items-center gap-2">
              <span className="w-4 tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="font-mono">{route}</span>
              {route === routes.pin ? (
                <Badge size="sm" variant="outline">
                  pinned
                </Badge>
              ) : null}
              <span className="ml-auto flex gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Move ${route} up`}
                  disabled={busy || !canChange || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  Up
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Move ${route} down`}
                  disabled={busy || !canChange || index === routes.routes.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  Down
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${route}`}
                  disabled={busy || !canChange || route === routes.pin}
                  onClick={() => void change({ op: "remove", route })}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const route = draft.trim();
          if (route === "") return;
          setDraft("");
          void change({ op: "add", route });
        }}
      >
        <Input
          size="sm"
          aria-label={`New route for ${alias}`}
          placeholder="SSH alias of the same machine"
          value={draft}
          disabled={busy || !canChange}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          type="submit"
          disabled={busy || !canChange || draft.trim() === ""}
        >
          {busy ? "Working…" : "Add route"}
        </Button>
      </form>
      {answer === null || (answer.state === "ok" && answer.code === undefined) ? null : (
        <p
          role={answer.state === "failed" ? "alert" : "status"}
          className={answer.state === "failed" ? "text-destructive" : "text-muted-foreground"}
        >
          {answer.message}
        </p>
      )}
    </section>
  );
}
