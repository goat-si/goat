import { AuthSettingsWriteScope, type EnvironmentId } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { createSshHostState } from "@goat/client-runtime/state/sshHost";
import { createServerEnvironmentAtoms } from "@goat/client-runtime/state/server";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@goat/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@goat/client-runtime/state/shell";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession, sessionHasScope } from "./session";

export const sshHost = createSshHostState(connectionAtomRuntime);

export const serverEnvironment = {
  ...createServerEnvironmentAtoms(connectionAtomRuntime, {
    initialConfigValueAtom: environmentSession.initialConfigValueAtom,
    usageLimitSources: true,
    usageLimitsCommand: true,
    providerCatalogsOnDemand: true,
    providerCatalogDigests: true,
  }),
  botTriggerSettingsPermissionAtom: Atom.family((id: EnvironmentId) =>
    Atom.map(environmentSession.sessionStateAtom(id), (session) =>
      sessionHasScope(session, AuthSettingsWriteScope),
    ),
  ),
};
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
