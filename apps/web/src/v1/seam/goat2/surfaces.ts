// @v1/surfaces: every lifted v1 surface GOAT 2 mounts, typed against surfaces.types.ts (see there). Also the typecheck
// entry of tsconfig.v1.json, so the v1 provider screens are checked even before a GOAT 2 frame mounts them.
import type * as Api from "./surfaces.types.ts";
import { V1Boundary as Boundary } from "../V1Boundary.tsx";
import { V1Fixture as Fixture } from "../fixture/V1Fixture.tsx";

export const V1Boundary: typeof Api.V1Boundary = Boundary;
export const V1Fixture: typeof Api.V1Fixture = Fixture;

// Lifted v1 provider screens and the provider port (P2-M); typed GOAT 2 entry points follow as the frames mount them.
export { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
export { ProviderSettingsPanel } from "../../components/settings/ProviderSettingsPanel";
export { AddProviderInstanceDialog } from "../../components/settings/AddProviderInstanceDialog";
export { providerClients } from "../../components/settings/providerDriverMeta";
import { installProviderPort as installPort, type ProviderPort } from "./providerPort";
export type { Goat2ProviderEntry } from "./providerPort";
// The host's entries are validated where they enter v1 (toServerProvider decodes with v1's ServerProvider schema),
// so the boundary accepts the plain GOAT 2 shape.
export const installProviderPort: typeof Api.installProviderPort = (port) => installPort(port as ProviderPort | null);

import { SettingsNavFrame } from "./SettingsNavFrame";
export const SettingsSidebarNav: typeof Api.SettingsSidebarNav = SettingsNavFrame;

import { setGoat2Location, setGoat2Navigator } from "../npm/tanstack-react-router";
export const setSettingsLocation: typeof Api.setSettingsLocation = setGoat2Location;
export const setSettingsNavigator: typeof Api.setSettingsNavigator = setGoat2Navigator;
