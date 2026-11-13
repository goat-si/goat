import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type { HubLinkDirection } from "@goat/client-runtime/state/hub-fleet";
import type { EnvironmentId, HubDeviceRoutesChange, HubDeviceRoutesResult } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface WaitingChange {
  readonly change: HubDeviceRoutesChange;
  readonly decisionId: string;
}

/**
 * A change from a session without settings:write waits for an inbox decision. Kept alive so it
 * can be continued after a visit to Settings → Decision inbox, keyed by environment and device.
 */
const waitingRoutesAtom = Atom.make<Readonly<Record<string, WaitingChange>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("hub-device-routes-waiting"),
);

/**
 * The SSH routes the Home tries for one Remote Link Child, read when a person opens them. A
 * person's change runs at once; the Home stores a new route only after it proved the link's key.
 * A link the Child opened (ocx link join) has no routes on the Home, so it offers none.
 */
export function HubDeviceRoutes({
  environmentId,
  alias,
  direction,
}: {
  readonly environmentId: EnvironmentId;
  readonly alias: string;
  readonly direction: HubLinkDirection | null;
}) {
  const canRead = useAtomValue(serverEnvironment.listHubDeviceRoutes.permissionAtom(environmentId));
  const canChange = useAtomValue(
    serverEnvironment.updateHubDeviceRoutes.permissionAtom(environmentId),
  );
  const list = useAtomCommand(serverEnvironment.listHubDeviceRoutes, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateHubDeviceRoutes, { reportFailure: false });
  const registry = useContext(RegistryContext);
  const waitingKey = `${environmentId}\u0000${alias}`;
  const waiting = useAtomValue(waitingRoutesAtom)[waitingKey] ?? null;
  const setWaiting = (next: WaitingChange | null) => {
    const rest = Object.fromEntries(
      Object.entries(registry.get(waitingRoutesAtom)).filter(([key]) => key !== waitingKey),
    );
    registry.set(waitingRoutesAtom, next === null ? rest : { ...rest, [waitingKey]: next });
  };
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [routes, setRoutes] = useState<{
    pin: string;
    routes: ReadonlyArray<string>;
    exclusive: boolean;
  } | null>(null);
  const [answer, setAnswer] = useState<HubDeviceRoutesResult | null>(null);
  // A read-back after a change fails on its own, beside the change's answer.
  const [readError, setReadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // An exclusive link's one route is fixed at enrollment; OpenCodex refuses every edit.
  // While a change waits for its decision, other edits wait too, so the slot holds that change.
  const editable = canChange && routes?.exclusive !== true && waiting === null;

  /**
   * keepAnswer: a read-back after a change. It updates the list and leaves the change's notice;
   * one that fails says so and drops the list, which no longer shows what the Home holds.
   */
  const settle = (result: Awaited<ReturnType<typeof list>>, keepAnswer = false) => {
    const failure =
      result._tag === "Failure"
        ? (() => {
            const cause = squashAtomCommandFailure(result);
            return cause instanceof Error ? cause.message : String(cause);
          })()
        : result.value.state === "ok"
          ? null
          : result.value.message;
    if (keepAnswer && failure !== null) {
      setReadError(failure);
      setRoutes(null);
      return;
    }
    if (result._tag === "Failure") {
      setAnswer({ deviceAlias: alias, state: "failed", message: failure ?? "" });
      return;
    }
    if (!keepAnswer) setAnswer(result.value);
    if (result.value.pin !== undefined && result.value.routes !== undefined)
      setRoutes({
        pin: result.value.pin,
        routes: result.value.routes,
        exclusive: result.value.exclusive === true,
      });
  };
  const read = async () => {
    setBusy(true);
    settle(await list({ environmentId, input: { deviceAlias: alias } }));
    setBusy(false);
  };
  const change = async (next: HubDeviceRoutesChange, decisionId?: string) => {
    setBusy(true);
    setReadError(null);
    const result = await update({
      environmentId,
      input: {
        deviceAlias: alias,
        change: next,
        ...(decisionId === undefined ? {} : { decisionId }),
      },
    });
    settle(result);
    // A failed call (such as a decision not answered yet) or a fixed refusal leaves the approval
    // unspent, so a waiting change stays continuable; only its own decision's answer settles it.
    if (result._tag === "Success") {
      const value = result.value;
      const own =
        decisionId !== undefined &&
        registry.get(waitingRoutesAtom)[waitingKey]?.decisionId === decisionId;
      if (value.state === "needs_human" && value.decisionId !== undefined)
        setWaiting({ change: next, decisionId: value.decisionId });
      else if (own && !(value.state === "failed" && value.code !== undefined)) setWaiting(null);
    }
    // A stored change that the Home could not apply yet still lists, so read it back, as does a
    // change continued from the row before the list was read.
    const listedNow = result._tag === "Success" && result.value.routes !== undefined;
    const stored = result._tag === "Success" && result.value.state === "ok";
    if (!listedNow && (stored || routes === null))
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

  const waitingNotice =
    waiting === null ? null : (
      <div className="space-y-1.5 text-xs">
        <p className="text-muted-foreground">
          A route change waits for a decision. A person who can change this hub's settings answers
          it in the decision inbox. Then continue here. Other edits wait until it is continued or
          discarded. Discard forgets it here; the decision stays in the inbox until it is answered.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="outline" render={<Link to="/settings/decision-inbox" />}>
            Open decision
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy || !canChange}
            onClick={() => {
              setOpen(true);
              void change(waiting.change, waiting.decisionId);
            }}
          >
            Continue
          </Button>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => setWaiting(null)}>
            Discard
          </Button>
        </div>
      </div>
    );

  if (direction !== "hub-initiated") return null;
  if (!open)
    return (
      <>
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
        {waitingNotice}
      </>
    );
  return (
    <section aria-label={`Routes of ${alias}`} className="space-y-2 rounded-md border p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium">SSH routes, tried in order</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {routes?.exclusive === true ? (
        <p className="text-muted-foreground">
          This link is exclusive: its one route is fixed, so it cannot be edited here.
        </p>
      ) : null}
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
                  disabled={busy || !editable || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  Up
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Move ${route} down`}
                  disabled={busy || !editable || index === routes.routes.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  Down
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${route}`}
                  disabled={busy || !editable || route === routes.pin}
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
          disabled={busy || !editable}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          size="xs"
          variant="outline"
          type="submit"
          disabled={busy || !editable || draft.trim() === ""}
        >
          {busy ? "Working…" : "Add route"}
        </Button>
      </form>
      {readError === null ? null : (
        <p role="alert" className="text-destructive">
          Could not read the routes again: {readError}
        </p>
      )}
      {answer === null || (answer.state === "ok" && answer.code === undefined) ? null : (
        <p
          role={answer.state === "failed" ? "alert" : "status"}
          className={answer.state === "failed" ? "text-destructive" : "text-muted-foreground"}
        >
          {answer.message}
        </p>
      )}
      {waitingNotice}
    </section>
  );
}
