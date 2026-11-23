import { useGT } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import { botManageFailure } from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  botPackageFileName,
  type BotPackageExportResult,
  type BotProfile,
  type EnvironmentId,
} from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { GoatBotPackageExportDialog, GoatBotPackageImportDialog } from "./GoatBotPackageDialog";

const NO_PERMISSION = Atom.make(false);
type Action = "exportBotPackage" | "reviewBotPackage" | "importBotPackage";

function usePackagePermission(environmentId: EnvironmentId, action: Action) {
  const environment = useEnvironment(environmentId);
  const supported = environment?.serverConfig?.environment.capabilities.goatBotPackages === true;
  return useAtomValue(
    supported ? channelEnvironment[action].permissionAtom(environmentId) : NO_PERMISSION,
  );
}

export function GoatBotPackageImportButton({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const canReview = usePackagePermission(environmentId, "reviewBotPackage");
  const canImport = usePackagePermission(environmentId, "importBotPackage");
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [open, setOpen] = useState(false);
  return canReview && canImport && canOperate ? (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {gt("Import bot package")}
      </Button>
      {open && <ImportPackage environmentId={environmentId} close={() => setOpen(false)} />}
    </>
  ) : null;
}

function ImportPackage({
  environmentId,
  close,
}: {
  readonly environmentId: EnvironmentId;
  readonly close: () => void;
}) {
  const review = useAtomCommand(channelEnvironment.reviewBotPackage, { reportFailure: false });
  const confirm = useAtomCommand(channelEnvironment.importBotPackage, { reportFailure: false });
  return (
    <GoatBotPackageImportDialog
      close={close}
      review={async (text) => {
        const result = await review({ environmentId, input: { text } });
        return result._tag === "Success"
          ? result.value
          : botManageFailure(squashAtomCommandFailure(result));
      }}
      confirm={async (input) => {
        const result = await confirm({ environmentId, input });
        return result._tag === "Success"
          ? undefined
          : botManageFailure(squashAtomCommandFailure(result));
      }}
    />
  );
}

export function useGoatBotPackageExport(environmentId: EnvironmentId) {
  const allowed = usePackagePermission(environmentId, "exportBotPackage");
  const [bot, setBot] = useState<BotProfile | null>(null);
  return {
    open: allowed ? setBot : undefined,
    dialog:
      allowed && bot?.environmentId === environmentId ? (
        <ExportPackage key={bot.botId} bot={bot} close={() => setBot(null)} />
      ) : null,
  };
}

function ExportPackage({ bot, close }: { readonly bot: BotProfile; readonly close: () => void }) {
  const send = useAtomCommand(channelEnvironment.exportBotPackage, { reportFailure: false });
  const [result, setResult] = useState<BotPackageExportResult | string | null>(null);
  const started = useRef(false);
  // oxlint-disable-next-line goat/react-effect-budget -- Fetch the preview once when its dialog mounts.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void send({ environmentId: bot.environmentId, input: { botId: bot.botId } }).then((response) =>
      setResult(
        response._tag === "Success"
          ? response.value
          : botManageFailure(squashAtomCommandFailure(response)),
      ),
    );
  }, [bot.botId, bot.environmentId, send]);
  return (
    <GoatBotPackageExportDialog
      name={bot.name}
      result={result}
      close={close}
      save={(contents) => {
        const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = botPackageFileName(bot.name);
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }}
    />
  );
}
