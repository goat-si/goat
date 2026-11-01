import { createFilesystemEnvironmentAtoms } from "@goat/client-runtime/state/filesystem";

import { connectionAtomRuntime } from "../connection/runtime";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);
