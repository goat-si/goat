import { createSshRuntimeState } from "@goat/client-runtime/state/sshRuntime";
import { connectionAtomRuntime } from "../connection/runtime";
import { desktopSshRuntimeGateway } from "../connection/platform";

export const sshRuntime = createSshRuntimeState(connectionAtomRuntime, desktopSshRuntimeGateway);
