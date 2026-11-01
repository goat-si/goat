import { migratingStorage } from "@goat/client-runtime/storage-migration";
import { useAtomValue } from "@effect/atom-react";
import { usesChatGptSharing } from "@goat/shared/usageLimits";
import { useState } from "react";
import { environmentPresentations } from "../../state/presentation";
import { ChatGptWelcomeDialog } from "../onboarding/ChatGptWelcomeDialog";

const STORAGE_KEY = "goat:chatgpt-sharing-welcome:v1";
function readAcknowledgedProfiles(): string[] {
  try {
    const value: unknown = JSON.parse(migratingStorage(localStorage).getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}

export function ChatGptWelcomeCoordinator() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const [acknowledged, setAcknowledged] = useState(readAcknowledgedProfiles);
  const profiles = [...presentations].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase !== "connected"
      ? []
      : (providersByEnvironment.get(environmentId) ?? [])
          .filter(usesChatGptSharing)
          .map((provider) => ({
            key: JSON.stringify([
              environmentId,
              provider.instanceId,
              provider.auth.profileId ?? provider.auth.email ?? "default",
            ]),
            environmentLabel: presentation.entry.target.label,
            providerName: provider.displayName ?? "Codex",
          })),
  );
  const next = profiles.find((profile) => !acknowledged.includes(profile.key));
  const dismiss = () => {
    if (!next) return;
    const updated = [...acknowledged, next.key];
    setAcknowledged(updated);
    try {
      migratingStorage(localStorage).setItem(STORAGE_KEY, JSON.stringify(updated));
    } catch {
      /* Session dismissal still works. */
    }
  };
  return (
    <ChatGptWelcomeDialog
      open={next !== undefined}
      providerName={next?.providerName}
      environmentLabel={next?.environmentLabel}
      onDismiss={dismiss}
    />
  );
}
