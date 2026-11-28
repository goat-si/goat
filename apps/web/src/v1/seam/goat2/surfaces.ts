// @v1/surfaces: every lifted v1 surface GOAT 2 mounts, typed against surfaces.types.ts (see there). Also the typecheck
// entry of tsconfig.v1.json, so the v1 provider screens are checked even before a GOAT 2 frame mounts them.
import type * as Api from "./surfaces.types.ts";
import { V1Boundary as Boundary } from "../V1Boundary.tsx";
import { V1Fixture as Fixture } from "../fixture/V1Fixture.tsx";
import { setGoat2Location, setGoat2Navigator } from "../npm/tanstack-react-router";
import { installProviderPort as installPort, type ProviderPort } from "./providerPort";
import { ProvidersSettingsScreen as ProvidersScreen } from "./ProvidersSettingsScreen";
import { SettingsNavFrame } from "./SettingsNavFrame";
import { Goat2ModelPicker } from "./Goat2ModelPicker";
import { BotModelSettings as BotModel } from "./BotModelSettings";

export const V1Boundary: typeof Api.V1Boundary = Boundary;
export const V1Fixture: typeof Api.V1Fixture = Fixture;

// The host's entries are validated where they enter v1 (toServerProvider decodes with v1's ServerProvider schema),
// so the boundary accepts the plain GOAT 2 shape.
export const installProviderPort: typeof Api.installProviderPort = (port) => installPort(port as ProviderPort | null);
export const ProvidersSettingsScreen: typeof Api.ProvidersSettingsScreen = ProvidersScreen;
export const SettingsSidebarNav: typeof Api.SettingsSidebarNav = SettingsNavFrame;
export const ModelPicker: typeof Api.ModelPicker = Goat2ModelPicker;
export const BotModelSettings: typeof Api.BotModelSettings = BotModel;

let current: Required<Api.V1Location> = { pathname: "/settings/providers", hash: "", search: {} };
export const setV1Location: typeof Api.setV1Location = (location) => {
  current = { pathname: location.pathname, hash: location.hash ?? "", search: { ...(location.search ?? {}) } };
  setGoat2Location({ ...current, state: {} });
};
export const setV1Navigator: typeof Api.setV1Navigator = (navigate) =>
  setGoat2Navigator((options) => {
    const search =
      typeof options.search === "function" ? options.search(current.search) : options.search ?? (options.to ? {} : current.search);
    navigate({ pathname: options.to ?? current.pathname, hash: options.hash ?? "", search });
  });

// Typecheck reach (tsconfig.v1.json): lifted provider screens GOAT 2 mounts through the wrappers above or next.
export { ProviderModelPicker } from "../../components/chat/ProviderModelPicker";
export { AddProviderInstanceDialog } from "../../components/settings/AddProviderInstanceDialog";
export { providerClients } from "../../components/settings/providerDriverMeta";
