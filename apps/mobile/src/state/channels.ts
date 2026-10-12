import { createChannelEnvironmentAtoms } from "@goat/client-runtime/state/channels";
import { connectionAtomRuntime } from "../connection/runtime";

export const channelEnvironment = createChannelEnvironmentAtoms(connectionAtomRuntime);
