import { hasProviderUsageLimits } from "@goat/shared/usageLimits";
import { parseCodexFeedbackCommand } from "@goat/client-runtime/state/threads";
import { parseSideChatCommand } from "./sideChatCommand";
import { resolveComposerSendIntercept } from "./composerSendIntercept";

export function mobileComposerLocalCommand(
  text: string,
  options: {
    attachmentCount: number;
    usageLimitsOffered: boolean;
    inThread: boolean;
    codex: boolean;
  },
): boolean {
  return (
    parseSideChatCommand(text) !== null ||
    resolveComposerSendIntercept({ text, ...options }) !== null ||
    (options.attachmentCount === 0 && options.codex && parseCodexFeedbackCommand(text) !== null)
  );
}

export function mobileComposerDraftIsLocal(
  text: string,
  props: import("./thread-composer-props").ThreadComposerProps,
  attachments: ReadonlyArray<unknown>,
  fork: { readonly interceptsFork: boolean },
): boolean {
  const provider =
    props.serverConfig?.providers.find(
      (entry) => entry.instanceId === props.selectedThread.modelSelection.instanceId,
    ) ?? null;
  return mobileComposerLocalCommand(text, {
    attachmentCount: attachments.length,
    usageLimitsOffered:
      provider !== null &&
      hasProviderUsageLimits(
        provider.driver,
        props.serverConfig?.providers ?? [],
        props.serverConfig?.usageLimitSources ?? [],
      ),
    inThread: fork.interceptsFork,
    codex: provider?.driver === "codex",
  });
}
