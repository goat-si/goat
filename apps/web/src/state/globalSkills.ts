import { createGlobalSkillsEnvironmentAtoms } from "@goat/client-runtime/state/global-skills";

import { connectionAtomRuntime } from "../connection/runtime";

export const globalSkillsEnvironment = createGlobalSkillsEnvironmentAtoms(connectionAtomRuntime);
