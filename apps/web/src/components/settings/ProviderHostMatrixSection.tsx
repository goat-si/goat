import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderHostSyncDriver } from "@goat/contracts";
import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { startProviderHostSync } from "./ProviderHostMatrix.commands";
import { useProviderHostMatrix } from "./ProviderHostMatrix.data";
import { machineColumns, providerCell, SYNC_PROVIDERS } from "./ProviderHostMatrix.logic";
import { ProviderHostSyncDialog } from "./ProviderHostSyncDialog";
import { searchableSetting } from "./settingsSearch";

function ProviderHostMatrixPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const matrix = useProviderHostMatrix(environmentId);
  const canSync = useAtomValue(startProviderHostSync.permissionAtom(environmentId));
  const [selection, setSelection] = useState<{
    driver: ProviderHostSyncDriver;
    displayName: string;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const columns = machineColumns(matrix.data?.rows ?? []);
  return (
    <>
      <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-xs sm:px-4">
        <p className="text-muted-foreground">Installed providers and sign-in on each machine.</p>
        <Button
          size="sm"
          variant="outline"
          disabled={matrix.pending}
          onClick={() => {
            void matrix.refresh();
          }}
        >
          Refresh
        </Button>
      </div>
      {!canSync ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Provider management permission is required to sync machines.
        </p>
      ) : null}
      {matrix.error ? (
        <p role="alert" className="px-3 py-2 text-xs text-destructive sm:px-4">
          {matrix.error}
        </p>
      ) : null}
      {matrix.pending ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          Reading providers…
        </p>
      ) : null}
      {matrix.data && columns.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground sm:px-4">
          No machines reported provider status. Refresh to try again.
        </p>
      ) : null}
      {columns.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Providers on your machines</caption>
            <thead>
              <tr className="border-b border-border/50">
                <th scope="col" className="px-3 py-2.5 font-medium sm:px-4">
                  Provider
                </th>
                {columns.map((row) => (
                  <th
                    scope="col"
                    key={row.host ?? "local"}
                    className="min-w-36 px-3 py-2.5 font-medium"
                  >
                    {row.message ? (
                      <Tooltip>
                        <TooltipTrigger render={<span tabIndex={0} />}>
                          {row.host ?? "This machine"}
                        </TooltipTrigger>
                        <TooltipPopup>{row.message}</TooltipPopup>
                      </Tooltip>
                    ) : (
                      (row.host ?? "This machine")
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYNC_PROVIDERS.map((provider) => (
                <tr key={provider.driver} className="border-b border-border/50 last:border-0">
                  <th scope="row" className="px-3 py-3 font-medium sm:px-4">
                    <div className="flex flex-col items-start gap-1.5">
                      {provider.displayName}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canSync}
                        aria-label={`Sync ${provider.displayName} to other hosts`}
                        onClick={() => {
                          setSelection(provider);
                          setOpen(true);
                        }}
                      >
                        Sync…
                      </Button>
                    </div>
                  </th>
                  {columns.map((row) => {
                    const cell = providerCell(row, provider.driver);
                    return (
                      <td key={row.host ?? "local"} className="px-3 py-3 align-top">
                        <div className="space-y-1">
                          {cell.message ? (
                            <Tooltip>
                              <TooltipTrigger render={<span tabIndex={0} />}>
                                {cell.version}
                              </TooltipTrigger>
                              <TooltipPopup>{cell.message}</TooltipPopup>
                            </Tooltip>
                          ) : (
                            <p>{cell.version}</p>
                          )}
                          {cell.auth ? (
                            <Badge
                              size="sm"
                              variant={cell.auth === "Signed in" ? "success" : "secondary"}
                            >
                              {cell.auth}
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {selection ? (
        <ProviderHostSyncDialog
          key={`${environmentId}:${selection.driver}`}
          environmentId={environmentId}
          driver={selection.driver}
          displayName={selection.displayName}
          open={open}
          onOpenChange={setOpen}
          onComplete={() => {
            void matrix.refresh();
          }}
        />
      ) : null}
    </>
  );
}

export function ProviderHostMatrixSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { id, title } = searchableSetting("provider-host-matrix");
  return (
    <FoldedSettingsSection id={id} title={title} summary="Install and sign in across machines">
      <ProviderHostMatrixPanel key={environmentId} environmentId={environmentId} />
    </FoldedSettingsSection>
  );
}
