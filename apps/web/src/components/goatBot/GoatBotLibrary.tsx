import {
  botArtifactName,
  botArtifactOpenMessage,
  botArtifactSizeLabel,
  botArtifactsFailure,
  readWholeBotArtifact,
} from "@goat/client-runtime/goatBot";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import type {
  ChannelBotArtifact,
  ChannelReadBotArtifactInput,
  EnvironmentId,
} from "@goat/contracts";
import { useEffect, useRef, useState } from "react";
import { channelEnvironment } from "~/state/channels";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";

const TEXT_TYPES = new Set(["application/json", "text/markdown", "text/csv"]);

type Preview =
  | { readonly kind: "image"; readonly name: string; readonly url: string }
  | { readonly kind: "text"; readonly name: string; readonly text: string };

/** Files GOAT Bot's workers saved; opening one reads it chunk by chunk from the home server. */
export function GoatBotLibrary({ environmentId }: { environmentId: EnvironmentId }) {
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.goatBotLibrary === true;
  const files = useEnvironmentQuery(
    supported ? channelEnvironment.listBotArtifacts({ environmentId, input: {} }) : null,
  );
  const refresh = files.refresh;
  // oxlint-disable-next-line goat/react-effect-budget -- Workers save files on the server at any time; read the folder again each time the tab opens.
  useEffect(() => {
    if (supported) refresh();
  }, [supported, refresh]);
  const read = useAtomCommand(channelEnvironment.readBotArtifact, { reportFailure: false });
  const [opening, setOpening] = useState<string | null>(null);
  const [messages, setMessages] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewUrl = useRef<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- A read and a preview's Blob URL outlive a render; stop the read and let the URL go when the tab goes away.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = null;
    };
  }, []);
  const closePreview = () => {
    if (previewUrl.current !== null) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPreview(null);
  };
  const readChunk = async (input: ChannelReadBotArtifactInput) => {
    const result = await read({ environmentId, input });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };
  const open = async (file: ChannelBotArtifact) => {
    const signal = lifetime.current?.signal;
    if (signal === undefined || signal.aborted) return;
    const name = botArtifactName(file.relativePath);
    setOpening(file.relativePath);
    setMessages(({ [file.relativePath]: _old, ...rest }) => rest);
    try {
      const result = await readWholeBotArtifact(file.relativePath, readChunk, signal);
      if (signal.aborted) return;
      if (result.status !== "ok") {
        setMessages((current) => ({
          ...current,
          [file.relativePath]: botArtifactOpenMessage(name, result),
        }));
        return;
      }
      const type = result.mimeType.split(";", 1)[0]?.trim() ?? "";
      if (type.startsWith("text/") || TEXT_TYPES.has(type)) {
        setPreview({ kind: "text", name, text: new TextDecoder().decode(result.bytes) });
        return;
      }
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mimeType }));
      if (type.startsWith("image/")) {
        previewUrl.current = url;
        setPreview({ kind: "image", name, url });
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      if (signal.aborted) return;
      setMessages((current) => ({
        ...current,
        [file.relativePath]: botArtifactsFailure(error).message,
      }));
    } finally {
      if (!signal.aborted) setOpening(null);
    }
  };
  if (!supported) return <p>Files need a newer GOAT server.</p>;
  const failure = files.failure === null ? null : botArtifactsFailure(files.failure);
  if (failure !== null)
    return (
      <div className="space-y-2">
        <p>{failure.message}</p>
        {failure.retry && (
          <Button size="xs" variant="outline" onClick={refresh}>
            Try again
          </Button>
        )}
      </div>
    );
  if (files.data === null) return <p className="text-muted-foreground">Loading files…</p>;
  if (files.data.artifacts.length === 0) return <p>Files GOAT Bot saves will appear here.</p>;
  return (
    <div className="space-y-3">
      {files.data.truncated && (
        <p className="text-xs text-muted-foreground">Showing the newest files only.</p>
      )}
      <ul className="space-y-1">
        {files.data.artifacts.map((file) => {
          const name = botArtifactName(file.relativePath);
          const folder = file.relativePath.slice(0, -name.length).replace(/\/$/, "");
          return (
            <li key={file.relativePath} className="border-b border-border pb-1">
              <Button
                variant="ghost"
                size="sm-multiline"
                aria-label={`Open ${name}`}
                disabled={opening !== null}
                onClick={() => void open(file)}
                className="w-full justify-start"
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">{name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[
                      folder,
                      botArtifactSizeLabel(file.size),
                      new Date(file.modifiedAt).toLocaleString(),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {opening === file.relativePath && (
                  <span className="text-xs text-muted-foreground">Opening…</span>
                )}
              </Button>
              {messages[file.relativePath] && (
                <p className="px-2 text-xs text-destructive-foreground">
                  {messages[file.relativePath]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{preview?.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {preview?.kind === "image" ? (
              <img src={preview.url} alt={preview.name} className="max-h-[70vh] max-w-full" />
            ) : preview?.kind === "text" ? (
              <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap text-xs">
                {preview.text}
              </pre>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
