import type { ThreadReferenceCopyTarget } from "@goat/client-runtime/thread-reference";
import { threadChipCopyTarget } from "@goat/client-runtime/thread-reference";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import * as Haptics from "expo-haptics";
import { writeComposerContextClipboard } from "./composerContextClipboard";
import { tryCopyTextWithHaptic } from "./copyTextWithHaptic";

export function copyThreadShell(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id" | "title">,
) {
  return copyThreadReference(
    threadChipCopyTarget(
      { environmentId: thread.environmentId, threadId: thread.id },
      thread.title,
    ),
  );
}

export async function copyThreadReference(target: ThreadReferenceCopyTarget): Promise<boolean> {
  if (!target.fragment)
    return tryCopyTextWithHaptic(target.value, { target: target.clipboardTarget });
  try {
    await writeComposerContextClipboard(target.value, target.fragment);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    return true;
  } catch (error) {
    console.error("Failed to copy thread", error);
    return false;
  }
}
