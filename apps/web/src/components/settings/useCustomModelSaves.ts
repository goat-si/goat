import { useEffect, useRef, useState } from "react";
import {
  readCustomModelEntries,
  toCustomModelSetting,
  type CustomModelDefinition,
} from "@goat/shared/model";
import * as Equal from "effect/Equal";
import { useStableCallback } from "../../hooks/useStableCallback";

type Model = CustomModelDefinition;
type ModelChange = { readonly slug: string; readonly before?: Model; readonly after?: Model };
interface CustomModelSave {
  readonly token: object;
  readonly changes: readonly ModelChange[];
  readonly status: "queued" | "inflight" | "replied";
  readonly key?: string;
  readonly raced?: true;
}

const customModelsKey = (models: readonly Model[]) =>
  JSON.stringify(readCustomModelEntries(models.map(toCustomModelSetting)));

function modelChanges(previous: readonly Model[], next: readonly Model[]): ModelChange[] {
  const before = new Map(previous.map((model) => [model.slug, model]));
  const after = new Map(next.map((model) => [model.slug, model]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((slug) => {
    const oldModel = before.get(slug);
    const newModel = after.get(slug);
    if (Equal.equals(oldModel, newModel)) return [];
    return [
      { slug, ...(oldModel ? { before: oldModel } : {}), ...(newModel ? { after: newModel } : {}) },
    ];
  });
}

function applyChanges(models: readonly Model[], changes: readonly ModelChange[]): readonly Model[] {
  let result = [...models];
  for (const { slug, before, after } of changes) {
    const index = result.findIndex((model) => model.slug === slug);
    if (after === undefined) {
      result = result.filter((model) => model.slug !== slug);
    } else if (before === undefined) {
      if (index < 0) result.push(after);
    } else if (index >= 0) {
      const current = result[index];
      if (!current) continue;
      result[index] = {
        ...current,
        ...(!Equal.equals(before.name, after.name) ? { name: after.name } : {}),
        ...(!Equal.equals(before.capabilities, after.capabilities)
          ? { capabilities: after.capabilities }
          : {}),
      };
    }
  }
  return result;
}

function applySaves(stored: readonly Model[], saves: readonly CustomModelSave[]): readonly Model[] {
  return saves.reduce((current, entry) => applyChanges(current, entry.changes), stored);
}

export function useCustomModelSaves(
  stored: readonly Model[],
  save: (next: readonly Model[]) => Promise<boolean> | void,
  normalize: (next: readonly Model[]) => readonly Model[],
) {
  const [saves, setSaves] = useState<readonly CustomModelSave[]>([]);
  const savesRef = useRef(saves);
  const storedRef = useRef(stored);
  const previousKeyRef = useRef(customModelsKey(stored));
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const storedKey = customModelsKey(stored);
  const publish = useStableCallback((next: readonly CustomModelSave[]) => {
    savesRef.current = next;
    setSaves(next);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- The server config stream acknowledges or supersedes local model saves.
  useEffect(() => {
    if (previousKeyRef.current === storedKey) return;
    previousKeyRef.current = storedKey;
    storedRef.current = stored;
    const echoed = savesRef.current.findLastIndex((entry) => entry.key === storedKey);
    publish(
      echoed >= 0
        ? savesRef.current.slice(echoed + 1)
        : savesRef.current.flatMap((entry) =>
            entry.status === "replied"
              ? []
              : [{ ...entry, ...(entry.status === "inflight" ? { raced: true as const } : {}) }],
          ),
    );
  }, [storedKey, stored, publish]);

  const update = useStableCallback((next: readonly Model[]) => {
    const changes = modelChanges(applySaves(storedRef.current, savesRef.current), next);
    const token = {};
    publish([...savesRef.current, { token, changes, status: "queued" }]);
    const result = queueRef.current.then(async () => {
      const index = savesRef.current.findIndex((entry) => entry.token === token);
      if (index < 0) return false;
      const sent = applyChanges(
        applySaves(storedRef.current, savesRef.current.slice(0, index)),
        changes,
      );
      const key = customModelsKey(normalize(sent));
      publish(
        savesRef.current.map((entry) =>
          entry.token === token ? { ...entry, status: "inflight", key } : entry,
        ),
      );
      try {
        const saved = (await save(sent)) === true;
        publish(
          savesRef.current.flatMap((entry) =>
            entry.token !== token
              ? [entry]
              : saved && !entry.raced
                ? [{ ...entry, status: "replied" as const }]
                : [],
          ),
        );
        return saved;
      } catch (error) {
        publish(savesRef.current.filter((entry) => entry.token !== token));
        throw error;
      }
    });
    queueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  return [applySaves(stored, saves), update] as const;
}
