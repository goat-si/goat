import { useAtomMount } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
import { resolveThreadProviderSkills } from "@goat/client-runtime/providerSkills";
import type { ThreadDetailScreenProps } from "./ThreadDetailScreenProps";

type TranscriptSkillsInput = Pick<
  ThreadDetailScreenProps,
  "environmentId" | "connectionStateLabel" | "showContent" | "threadCwd" | "projectWorkspaceRoot"
> & {
  readonly serverConfig: Parameters<typeof resolveThreadProviderSkills>[0];
  readonly selectedThread: {
    readonly modelSelection: Pick<
      ThreadDetailScreenProps["selectedThread"]["modelSelection"],
      "instanceId"
    >;
    readonly projectId: ThreadDetailScreenProps["selectedThread"]["projectId"];
  };
};

const idleTranscriptRefresh = Atom.make(undefined);

export function useThreadTranscriptSkills(input: TranscriptSkillsInput, withoutComposer: boolean) {
  const { environmentId, selectedThread, serverConfig } = input;
  const { instanceId } = selectedThread.modelSelection;
  const cwd = input.threadCwd ?? input.projectWorkspaceRoot;
  useAtomMount(
    withoutComposer &&
      input.showContent !== false &&
      input.connectionStateLabel === "connected" &&
      cwd &&
      serverConfig?.providers.some((provider) => provider.instanceId === instanceId)
      ? providerWorkspaceSnapshotRefresh({ environmentId, instanceId, cwd })
      : idleTranscriptRefresh,
  );
  return resolveThreadProviderSkills(serverConfig, instanceId, cwd, selectedThread.projectId);
}
