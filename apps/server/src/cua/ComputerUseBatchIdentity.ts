import { cuaAppKey } from "@goat/shared/cuaDriverManifest";
import { batchAppScope, MAX_BATCH_SCOPE_APPS } from "./ComputerUseBatchScope.ts";
import type { ListedApp } from "./ComputerUseScope.ts";
import type { Envelope } from "./ComputerUseLeaseProtocol.ts";
import { refusal, type JsonRpcId } from "./ComputerUseLeaseResponses.ts";

const matches = (wanted: string, app: ListedApp) =>
  [app.id, app.name, app.executable].some(
    (value) => value !== undefined && cuaAppKey(value) === cuaAppKey(wanted),
  );

export const batchNeedsListing = (message: Envelope, listed: ReadonlyMap<number, ListedApp>) => {
  const batch = batchAppScope(message.params?.name, message.params?.arguments);
  return (
    batch?.apps.some((wanted) => {
      const entries = [...listed.values()].filter((app) => matches(wanted, app));
      return (
        entries.length === 0 ||
        entries.some(
          (app) =>
            app.bundleId === undefined ||
            cuaAppKey(app.bundleId) !== cuaAppKey(wanted) ||
            [app.name, app.executable].some(
              (alias) => alias !== undefined && cuaAppKey(alias) === cuaAppKey(wanted),
            ),
        )
      );
    }) === true
  );
};

export const narrowBatch = (
  id: JsonRpcId,
  line: string,
  message: Envelope,
  listed: ReadonlyMap<number, ListedApp>,
  bundleIds: boolean,
) => {
  const batch = batchAppScope(message.params?.name, message.params?.arguments);
  if (batch === undefined) return { line, message };
  const canonical = new Set<string>();
  for (const wanted of batch.apps) {
    const entries = [...listed.values()].filter((app) => matches(wanted, app));
    if (!bundleIds || entries.length === 0 || entries.some((app) => app.bundleId === undefined))
      return {
        refused: refusal(
          id,
          message.method,
          "app_not_allowed",
          "The batch app scope cannot be verified, so the call did not run.",
        ),
      };
    for (const app of entries) if (app.bundleId !== undefined) canonical.add(app.bundleId);
  }
  if (canonical.size > MAX_BATCH_SCOPE_APPS)
    return {
      refused: refusal(
        id,
        message.method,
        "app_not_allowed",
        "The batch app scope has too many verified apps, so the call did not run.",
      ),
    };
  const raw: unknown = JSON.parse(line);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      refused: refusal(
        id,
        message.method,
        "app_not_allowed",
        "The batch app scope cannot be verified, so the call did not run.",
      ),
    };
  const args = {
    ...message.params?.arguments,
    app_scope: { apps: [...canonical], delivery: batch.delivery },
  };
  const params = { ...message.params, arguments: args };
  return { line: JSON.stringify({ ...raw, params }), message: { ...message, params } };
};
