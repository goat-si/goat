import { connectionRoutes, formatConnectionDiagnostic } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";

import { APP_VERSION } from "~/branding";
import type { EnvironmentPresentation } from "~/state/environments";
import { sshRuntime } from "~/state/sshRuntime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useStableCallback } from "./useStableCallback";

export function useCopyConnectionDiagnostic(environment: EnvironmentPresentation | null) {
  const { copyToClipboard } = useCopyToClipboard({
    target: "connection diagnostic",
    onCopy: () => toastManager.add({ type: "success", title: "Diagnostic copied" }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy diagnostic",
          description: error.message,
        }),
      ),
  });
  return useStableCallback(() => {
    if (!environment) return;
    const sshProfile = connectionRoutes(environment.entry).flatMap(({ profile }) =>
      Option.isSome(profile) && profile.value._tag === "SshConnectionProfile"
        ? [profile.value]
        : [],
    )[0];
    const runtime =
      sshProfile && window.desktopBridge !== undefined
        ? appAtomRegistry.get(
            sshRuntime.statusAtom({
              environmentId: environment.environmentId,
              target: sshProfile.target,
            }),
          )
        : null;
    const runtimeFailure =
      runtime?.status?.state === "failed" ||
      runtime?.status?.state === "auth_failed" ||
      runtime?.status?.state === "untrusted";
    const diagnosticTail =
      runtime?.kind === "error"
        ? runtime.message
        : ((runtimeFailure ? runtime.status?.detail : undefined) ??
          environment.connection.failure?.detail ??
          environment.connection.error ??
          runtime?.status?.detail);
    copyToClipboard(
      formatConnectionDiagnostic({
        label: environment.label,
        hostAlias: sshProfile?.target.alias,
        connection: environment.connection,
        diagnosticTail,
        appVersion: APP_VERSION,
      }),
      undefined,
    );
  });
}
