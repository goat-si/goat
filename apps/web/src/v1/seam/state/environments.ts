// Seam for v1 apps/web/src/state/environments.ts (goat 916b5ccc1b2): the one GOAT 2 environment, the local host this
// app's desktop shell started (v1's primary target), connected once the host has sent its provider list.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import type { ConnectionCatalogEntry, EnvironmentConnectionPresentation } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";

import { GOAT2_ENVIRONMENT_ID, GOAT2_ENVIRONMENT_LABEL } from "../goat2/environment";
import { serverEnvironment, type Goat2ServerConfig } from "./server";

export interface EnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: Goat2ServerConfig | null;
}

const ENTRY: ConnectionCatalogEntry = {
  target: { _tag: "PrimaryConnectionTarget", label: GOAT2_ENVIRONMENT_LABEL },
  profile: Option.none(),
  enabled: true,
};

function presentation(serverConfig: Goat2ServerConfig | null): EnvironmentPresentation {
  return {
    environmentId: GOAT2_ENVIRONMENT_ID,
    label: GOAT2_ENVIRONMENT_LABEL,
    displayUrl: null,
    relayManaged: false,
    entry: ENTRY,
    connection: { phase: serverConfig ? "connected" : "connecting", error: null, traceId: null },
    serverConfig,
  };
}

function useLocal(): EnvironmentPresentation {
  return presentation(useAtomValue(serverEnvironment.configValueAtom(GOAT2_ENVIRONMENT_ID)));
}

export function useEnvironments() {
  const local = useLocal();
  return {
    isReady: true,
    networkStatus: "online" as const,
    environments: [local],
    presentationById: new Map([[local.environmentId, local]]),
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return GOAT2_ENVIRONMENT_ID;
}

export function readPrimaryEnvironmentId(): EnvironmentId | null {
  return GOAT2_ENVIRONMENT_ID;
}

export function useEnvironment(environmentId: EnvironmentId | null): EnvironmentPresentation | null {
  const local = useLocal();
  return environmentId === GOAT2_ENVIRONMENT_ID ? local : null;
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useLocal();
}
