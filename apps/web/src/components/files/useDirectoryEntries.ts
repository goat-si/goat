import type { EnvironmentId, ProjectEntry } from "@goat/contracts";
import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import { executeAtomQuery } from "@goat/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

export function useDirectoryEntries(environmentId: EnvironmentId, cwd: string) {
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(1);
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  const requests = useRef(new Map<string, Promise<void>>());
  const followUpRefreshes = useRef(new Map<string, Promise<void>>());
  const listings = useRef(new Map<string, readonly ProjectEntry[]>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  // Listed folders a refresh has not read again yet. `revalidate` reads one once it is on screen.
  const stale = useRef(new Set<string>());
  const active = useRef(true);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  const startRequest = (directoryPath: string, refresh: boolean): Promise<void> => {
    loaded.current.add(directoryPath);
    requested.current.add(directoryPath);
    stale.current.delete(directoryPath);
    const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
    const request = (async () => {
      if (running.current >= 4) await new Promise<void>((resolve) => waiting.current.push(resolve));
      else running.current++;
      const result = active.current
        ? await executeAtomQuery(appAtomRegistry, atom, {
            refresh: true,
            reportFailure: false,
            reportDefect: false,
          })
        : undefined;
      const next = waiting.current.shift();
      if (next) next();
      else running.current--;
      return result;
    })()
      .then((result) => {
        if (!active.current || !result) return;
        if (result._tag === "Success") {
          const children = result.value.entries.filter(
            (entry) =>
              entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
          );
          const listed = listings.current.get(directoryPath);
          const next = new Map(listings.current).set(directoryPath, children);
          // A refresh that finds a folder as it was publishes nothing, so the tree is not rebuilt.
          const unchanged =
            listed?.length === children.length &&
            children.every((entry, index) => {
              const known = listed[index];
              return (
                known !== undefined &&
                entry.path === known.path &&
                entry.kind === known.kind &&
                entry.ignored === known.ignored
              );
            });
          if (!unchanged) {
            listings.current = next;
            setDirectories(next);
          }
          setErrors((previous) => {
            if (!previous.has(directoryPath)) return previous;
            const remaining = new Map(previous);
            remaining.delete(directoryPath);
            return remaining;
          });
        } else {
          loaded.current.delete(directoryPath);
          const cause = Cause.squash(result.cause);
          setErrors((previous) =>
            new Map(previous).set(
              directoryPath,
              cause instanceof Error ? cause.message : "Unable to load folder.",
            ),
          );
        }
      })
      .finally(() => {
        requests.current.delete(directoryPath);
        if (!active.current) return;
        setPending((count) => count - 1);
        if (!refresh)
          setLoadingDirectories((previous) => {
            const next = new Set(previous);
            next.delete(directoryPath);
            return next;
          });
      });
    requests.current.set(directoryPath, request);
    return request;
  };

  const load = function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
    const existing = requests.current.get(directoryPath);
    if (existing) {
      if (!refresh) return existing;
      let followUp = followUpRefreshes.current.get(directoryPath);
      if (!followUp) {
        followUp = existing.then(() => {
          followUpRefreshes.current.delete(directoryPath);
          if (active.current) return loadDirectory(directoryPath, true);
        });
        followUpRefreshes.current.set(directoryPath, followUp);
      }
      return followUp;
    }
    if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
    setPending((count) => count + 1);
    if (!refresh) setLoadingDirectories((previous) => new Set(previous).add(directoryPath));
    return startRequest(directoryPath, refresh);
  };

  // A folder read fails at once while its environment is unreachable; read it again once a new
  // session is up rather than leaving the error until someone retries by hand.
  const sessionGeneration = environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    for (const path of errors.keys()) void load(path);
  });

  const entries: ProjectEntry[] = [];
  const visit = (path: string) => {
    for (const entry of directories.get(path) ?? []) {
      entries.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");

  const reachableDirectories = new Set([
    "",
    ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  ]);

  useEffect(() => {
    active.current = true;
    if (!requests.current.has("") && !loaded.current.has("")) void startRequest("", false);
    return () => {
      active.current = false;
    };
  }, [startRequest]);

  // Reads the root again and leaves every other listed folder to `revalidate`, so a refresh costs
  // what is on screen rather than every folder the tree has listed.
  const refresh = () => {
    if (!active.current) return;
    for (const path of requested.current) if (path !== "") stale.current.add(path);
    void load("", true);
  };

  /** Reads again the stale listings that put a row on screen: `directoryPath` and its ancestors. */
  const revalidate = (directoryPath: string) => {
    if (!active.current) return;
    for (
      let end = directoryPath.length;
      end > 0 && stale.current.size > 0;
      end = directoryPath.lastIndexOf("/", end - 1)
    ) {
      const path = directoryPath.slice(0, end);
      if (stale.current.delete(path)) void load(path, true);
    }
  };

  return {
    entries,
    load,
    refresh,
    revalidate,
    isPending: pending > 0,
    loadingDirectories,
    ready: directories.has(""),
    error: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
