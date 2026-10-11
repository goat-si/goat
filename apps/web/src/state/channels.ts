import { createChannelEnvironmentAtoms } from "@t3tools/client-runtime/state/channels";

import { connectionAtomRuntime } from "../connection/runtime";

export const channelEnvironment = createChannelEnvironmentAtoms(connectionAtomRuntime);
