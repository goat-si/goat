import { ProviderDriverKind } from "@goat/contracts";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
const CODEX_PROVIDER = ProviderDriverKind.make("codex");

export function toProtocolError(
  detail: string,
  payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}
