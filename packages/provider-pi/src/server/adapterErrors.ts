import type { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

export const makePiProtocolError =
  (driver: ProviderDriverKind) => (detail: string, payload?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail,
      ...(payload === undefined ? {} : { payload }),
    });
