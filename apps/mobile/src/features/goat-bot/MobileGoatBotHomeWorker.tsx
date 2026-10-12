import { createGoatBotHomeSync } from "@goat/client-runtime/goatBot";
import { useEffect, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { useMobileGoatBotHomeSettings } from "./useMobileGoatBotHomeSettings";

/** Mounted once beside the outbox worker, independently of screen navigation. */
export function MobileGoatBotHomeWorker() {
  const { supported, preferencesLoaded, targets, resolution, candidateId, writableIds, write } =
    useMobileGoatBotHomeSettings();
  const [revision, wake] = useState(0);
  const [controller] = useState(() =>
    createGoatBotHomeSync({
      now: Date.now,
      randomId: uuidv4,
      onSettled: () => wake((value) => value + 1),
    }),
  );
  useEffect(() => {
    controller.setActive(true);
    return () => controller.setActive(false);
  }, [controller]);
  useEffect(() => {
    if (!supported || !preferencesLoaded) return;
    const { nextWakeAt } = controller.update({
      targets,
      resolution,
      candidateId,
      writableIds,
      write,
    });
    if (nextWakeAt === null) return;
    const timer = setTimeout(
      () => wake((value) => value + 1),
      Math.max(0, nextWakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [
    controller,
    supported,
    preferencesLoaded,
    targets,
    resolution,
    candidateId,
    writableIds,
    write,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Completion and backoff wake retry planning.
    revision,
  ]);
  return null;
}
