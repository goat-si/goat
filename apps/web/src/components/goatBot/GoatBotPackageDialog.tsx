import {
  BOT_PACKAGE_EXTENSION,
  BOT_PACKAGE_MAX_BYTES,
  type BotPackageExportResult,
  type BotPackageImportInput,
  type BotPackageReviewResult,
} from "@goat/contracts";
import { useState } from "react";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function GoatBotPackageExportDialog({
  name,
  result,
  close,
  save,
}: {
  readonly name: string;
  readonly result: BotPackageExportResult | string | null;
  readonly close: () => void;
  readonly save: (contents: string) => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => open || close()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Share {name}</DialogTitle>
          <DialogDescription>Review the setup before saving the package.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {result === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Preparing package…
            </p>
          ) : typeof result === "string" ? (
            <p role="alert" className="text-sm">
              {result}
            </p>
          ) : result.status === "blocked" ? (
            <div role="alert" className="grid gap-2 text-sm">
              <p>
                Export blocked. Edit the text in these fields to remove possible secrets, then try
                again.
              </p>
              <FieldPaths paths={result.fields} />
            </div>
          ) : (
            <PackageContents label="Package contents" contents={result.contents} />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          {typeof result === "object" && result?.status === "ready" && (
            <Button onClick={() => save(result.contents)}>Save package</Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

type ReviewedFile = {
  readonly text: string;
  readonly review: BotPackageReviewResult;
  readonly clientRequestId: string;
};

export function GoatBotPackageImportDialog({
  review,
  confirm,
  close,
}: {
  readonly review: (text: string) => Promise<BotPackageReviewResult | string>;
  readonly confirm: (input: BotPackageImportInput) => Promise<string | undefined>;
  readonly close: () => void;
}) {
  const [selected, setSelected] = useState<ReviewedFile>();
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string>();

  const readFile = (file: File | undefined) => {
    setSelected(undefined);
    setError(undefined);
    if (file === undefined) return;
    if (file.size > BOT_PACKAGE_MAX_BYTES) {
      setError("Bot packages must fit in 64 KB.");
      return;
    }
    setBusy(true);
    void file
      .text()
      .then(async (text) => {
        const result = await review(text);
        if (typeof result === "string") {
          setError(result);
          return;
        }
        setSelected({ text, review: result, clientRequestId: randomUUID() });
      })
      .catch(() => setError("Could not read the package file."))
      .finally(() => setBusy(false));
  };

  const importReviewed = () => {
    if (selected === undefined || busy) return;
    setBusy(true);
    setAttempted(true);
    setError(undefined);
    void confirm({
      text: selected.text,
      digest: selected.review.digest,
      clientRequestId: selected.clientRequestId,
    })
      .then((failure) => {
        if (failure === undefined) close();
        else setError(failure);
      })
      .catch(() => setError("Could not import the bot. Try again."))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => open || busy || close()}>
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import a bot package</DialogTitle>
          <DialogDescription>
            Review the setup before creating a bot on this computer.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3 text-sm">
            <label className="grid gap-1.5">
              Package file
              <Input
                type="file"
                accept={BOT_PACKAGE_EXTENSION}
                disabled={busy || attempted}
                onChange={(event) => readFile(event.currentTarget.files?.[0])}
              />
            </label>
            {selected !== undefined && (
              <>
                <PackageContents
                  label="Reviewed package"
                  contents={JSON.stringify(selected.review.botPackage, null, 2)}
                />
                <p className="text-muted-foreground">
                  Automations start paused. Signed triggers need a local signing secret. Tool access
                  starts empty. Map tool names in Edit bot → Tools.
                </p>
                {selected.review.droppedFields.length > 0 && (
                  <div className="grid gap-1">
                    <p className="font-medium">Ignored fields</p>
                    <FieldPaths paths={selected.review.droppedFields} />
                  </div>
                )}
              </>
            )}
            {error !== undefined && (
              <p role="alert" className="text-destructive-foreground">
                {error}
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Close
          </Button>
          <Button disabled={busy || selected === undefined} onClick={importReviewed}>
            {attempted ? "Retry import" : "Import bot"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function PackageContents({
  label,
  contents,
}: {
  readonly label: string;
  readonly contents: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium [&_textarea]:font-mono">
      {label}
      <Textarea rows={12} readOnly value={contents} spellCheck={false} />
    </label>
  );
}

function FieldPaths({ paths }: { readonly paths: readonly string[] }) {
  return (
    <ul className="max-h-24 list-disc space-y-1 overflow-auto ps-5">
      {paths.map((path) => (
        <li key={path} className="break-all font-mono" dir="ltr">
          {path}
        </li>
      ))}
    </ul>
  );
}
