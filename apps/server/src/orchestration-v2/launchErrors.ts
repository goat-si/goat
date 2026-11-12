import { OrchestrationV2ThreadLaunchError } from "@goat/contracts";

type LaunchIds = Pick<
  ConstructorParameters<typeof OrchestrationV2ThreadLaunchError>[0],
  "commandId" | "projectId"
>;

/** A client launch failure; without a message it carries the cause's own text, written for people. */
export const launchErrorFor =
  (input: LaunchIds, message?: string) => (cause: { readonly message: string }) =>
    new OrchestrationV2ThreadLaunchError({
      commandId: input.commandId,
      projectId: input.projectId,
      message: message ?? cause.message,
      cause,
    });
