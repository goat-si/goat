import { LOCAL_DEVICE_HOST_ID, type DeviceHostId, type DeviceServiceState } from "@goat/contracts";

export function withHostStatus(
  state: DeviceServiceState,
  hostId: DeviceHostId,
  status: DeviceServiceState["hostStatuses"][string],
  discoveryDetails: ReadonlyMap<DeviceHostId, string>,
): DeviceServiceState {
  const previous = state.hostStatuses[hostId];
  const detail =
    status.detail ??
    (status.status === "ready" &&
    (previous?.incompletePlatforms || previous?.androidDiscoveryIncomplete)
      ? discoveryDetails.get(hostId)
      : undefined);
  return {
    ...state,
    ...(hostId === LOCAL_DEVICE_HOST_ID
      ? { hostStatus: status.status, hostStatusDetail: detail }
      : {}),
    hostStatuses: {
      ...state.hostStatuses,
      [hostId]: {
        ...(previous?.androidDiscoveryIncomplete ? { androidDiscoveryIncomplete: true } : {}),
        ...(previous?.incompletePlatforms
          ? { incompletePlatforms: previous.incompletePlatforms }
          : {}),
        ...status,
        ...(detail ? { detail } : {}),
      },
    },
  };
}
