import type {
  DesktopSshEnvironmentTarget,
  DesktopSshPreparationProgress,
  EnvironmentId,
} from "@goat/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

export type PendingSshAddOutcome =
  | { readonly _tag: "connected" }
  /** Superseded or interrupted: the add ends without a row, banner or toast. */
  | { readonly _tag: "dropped" }
  | { readonly _tag: "failed"; readonly message: string };

export interface PendingSshAddRequest {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly target: DesktopSshEnvironmentTarget;
  readonly label: string;
  /** The saved machine a route add must reach; null for a new device. */
  readonly routeEnvironmentId: EnvironmentId | null;
  readonly run: (
    report: (progress: DesktopSshPreparationProgress) => void,
  ) => Promise<PendingSshAddOutcome>;
  /** Runs only when the attempt that connected is still the listed one. */
  readonly onConnected: () => void;
}

export interface PendingSshAdd extends PendingSshAddRequest {
  readonly attempt: number;
  readonly progress: DesktopSshPreparationProgress | null;
  /** Null while the add is running. */
  readonly error: string | null;
}

/**
 * SSH adds that outlive the Add device dialog. The registry keeps them while the user is
 * elsewhere, so Settings and Fleet show the same rows and a late failure is still listed.
 */
export const pendingSshAddsAtom = Atom.make<ReadonlyArray<PendingSshAdd>>([]).pipe(Atom.keepAlive);

let attempts = 0;

function update(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  attempt: number,
  change: (add: PendingSshAdd) => PendingSshAdd | null,
) {
  const list = registry.get(pendingSshAddsAtom);
  const current = list.find((add) => add.key === key);
  if (current?.attempt !== attempt) return false;
  const next = change(current);
  registry.set(
    pendingSshAddsAtom,
    next === null
      ? list.filter((add) => add !== current)
      : list.map((add) => (add === current ? next : add)),
  );
  return true;
}

/** Lists and runs an add; resolves once it settles. Null, without running it, while one for the key runs. */
export function startPendingSshAdd(
  registry: AtomRegistry.AtomRegistry,
  request: PendingSshAddRequest,
): Promise<void> | null {
  const list = registry.get(pendingSshAddsAtom);
  const existing = list.find((add) => add.key === request.key);
  if (existing !== undefined && existing.error === null) return null;
  const attempt = ++attempts;
  const add: PendingSshAdd = { ...request, attempt, progress: null, error: null };
  registry.set(
    pendingSshAddsAtom,
    existing === undefined
      ? [...list, add]
      : list.map((entry) => (entry === existing ? add : entry)),
  );
  const report = (progress: DesktopSshPreparationProgress) =>
    void update(registry, request.key, attempt, (current) =>
      current.error === null ? { ...current, progress } : current,
    );
  return request
    .run(report)
    .catch((): PendingSshAddOutcome => ({ _tag: "failed", message: "Failed to connect SSH host." }))
    .then((outcome) => {
      const current = update(registry, request.key, attempt, (entry) =>
        outcome._tag === "failed" ? { ...entry, progress: null, error: outcome.message } : null,
      );
      if (current && outcome._tag === "connected") request.onConnected();
    });
}

export function retryPendingSshAdd(registry: AtomRegistry.AtomRegistry, key: string) {
  const add = registry.get(pendingSshAddsAtom).find((entry) => entry.key === key);
  if (add === undefined || add.error === null) return null;
  const { attempt: _attempt, progress: _progress, error: _error, ...request } = add;
  return startPendingSshAdd(registry, request);
}

export function dismissPendingSshAdd(registry: AtomRegistry.AtomRegistry, key: string) {
  const add = registry.get(pendingSshAddsAtom).find((entry) => entry.key === key);
  if (add === undefined || add.error === null) return;
  update(registry, key, add.attempt, () => null);
}
