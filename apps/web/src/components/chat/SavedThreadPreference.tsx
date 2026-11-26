import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@goat/contracts";
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { validateMemorySettingsSearch } from "../settings/MemorySettings.logic";
import { memoryEnvironment } from "../../state/memory";

export function SavedThreadPreference({ thread }: { thread: ScopedThreadRef }) {
  const saved = useAtomValue(memoryEnvironment.savedThreadPreference(thread));
  const gt = useGT();
  if (!saved) return null;
  return (
    <div className="chat-content-lane py-1 text-xs text-muted-foreground">
      <span>{gt("Preference saved from this conversation")}</span>{" "}
      <Link
        to="/settings/memory"
        search={validateMemorySettingsSearch({ environmentId: thread.environmentId, ...saved })}
        className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {gt("View")}
      </Link>
    </div>
  );
}
