import {
  AuthVoiceManageScope,
  type EnvironmentId,
  type SpeechConfiguration,
  type SpeechModelList,
} from "@goat/contracts";
import {
  configureEnvironmentSpeech,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechConfiguration,
  listEnvironmentSpeechModels,
  removeEnvironmentSpeechModel,
  type EnvironmentVoiceRequestContext,
} from "@goat/client-runtime/voice-input";
import { useEffect, useRef, useState } from "react";
import { useStableCallback } from "../hooks/useStableCallback";
import { readEnvironmentScope } from "../state/session";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";

import { chooseSetupSpeechModel, filterSpeechModels } from "./speechModelBrowser";

type Model = (typeof SpeechModelList.Type.models)[number];
export function VoiceModelDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: EnvironmentId;
  label: string;
  canManage: boolean;
  resolveContext: (id: EnvironmentId) => Promise<EnvironmentVoiceRequestContext | null>;
}) {
  const [search, setSearch] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [sort, setSort] = useState<"recommended" | "size" | "name">("recommended");
  const [models, setModels] = useState<readonly Model[]>([]);
  const [config, setConfig] = useState<SpeechConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useStableCallback(async (signal: AbortSignal) => {
    if (!props.canManage || !readEnvironmentScope(props.environmentId, AuthVoiceManageScope))
      throw new Error("This connection cannot manage voice models.");
    const context = await props.resolveContext(props.environmentId);
    signal.throwIfAborted();
    if (!context || !readEnvironmentScope(props.environmentId, AuthVoiceManageScope))
      throw new Error("Connect to an environment with voice management permission.");
    const [list, current] = await Promise.all([
      listEnvironmentSpeechModels(context, signal),
      getEnvironmentSpeechConfiguration(context, signal),
    ]);
    signal.throwIfAborted();
    setModels(list.models);
    setConfig(current);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- Cancel model requests when the dialog closes or the destination changes.
  useEffect(() => {
    if (!props.open || !props.canManage) return;
    const controller = new AbortController();
    active.current = controller;
    void Promise.resolve()
      .then(() => refresh(controller.signal))
      .then(() => {
        if (!controller.signal.aborted) setBusy(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setBusy(false);
          setError(cause instanceof Error ? cause.message : "Could not load voice models.");
        }
      });
    return () => {
      controller.abort();
      if (active.current === controller) active.current = null;
    };
  }, [props.open, props.canManage, refresh]);

  async function mutate(
    operation: (context: EnvironmentVoiceRequestContext, signal: AbortSignal) => Promise<unknown>,
  ) {
    const signal = active.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      busy ||
      !props.canManage ||
      !readEnvironmentScope(props.environmentId, AuthVoiceManageScope)
    )
      return;
    setBusy(true);
    setError(null);
    // A promise chain instead of try/finally keeps this component compiled by React Compiler.
    const failure = await props
      .resolveContext(props.environmentId)
      .then(async (context) => {
        signal.throwIfAborted();
        if (!context || !readEnvironmentScope(props.environmentId, AuthVoiceManageScope))
          throw new Error("Voice management permission is no longer available.");
        await operation(context, signal);
        await refresh(signal);
        return null;
      })
      .catch((cause: unknown) => cause ?? new Error("Could not update the voice model."));
    if (signal.aborted) return;
    if (failure !== null)
      setError(failure instanceof Error ? failure.message : "Could not update the voice model.");
    setBusy(false);
  }
  const preferredLanguages =
    typeof navigator === "undefined"
      ? []
      : [window.desktopBridge?.getSystemLocale?.() ?? "", ...navigator.languages];
  const recommendation = chooseSetupSpeechModel(models, preferredLanguages);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Voice models on {props.label}</DialogTitle>
          <DialogDescription>
            Download a model on this environment before sending it recordings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {!props.canManage ? (
            <p>Voice model management permission is required on this environment.</p>
          ) : null}
          {error ? <p role="alert">{error}</p> : null}
          {busy ? <p role="status">Updating voice model…</p> : null}
          <label>
            Search models{" "}
            <input value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label>
            <input
              type="checkbox"
              checked={installedOnly}
              onChange={(event) => setInstalledOnly(event.target.checked)}
            />{" "}
            Downloaded only
          </label>
          <label>
            Sort models{" "}
            <select
              value={sort}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "recommended" || value === "size" || value === "name") setSort(value);
              }}
            >
              <option value="recommended">Recommended</option>
              <option value="size">Size</option>
              <option value="name">Name</option>
            </select>
          </label>
          {recommendation ? <p>Suggested for your language: {recommendation.name}</p> : null}
          {filterSpeechModels(models, search, installedOnly, sort).map((model) => (
            <div key={model.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p>
                  {model.name}
                  {model.selected ? " (selected)" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {model.description} · {(model.size / 1_000_000_000).toFixed(1)} GB
                </p>
              </div>
              <div className="flex gap-1">
                {!model.installed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !props.canManage}
                    onClick={() =>
                      void mutate((ctx, signal) =>
                        downloadEnvironmentSpeechModel(ctx, model.id, signal),
                      )
                    }
                  >
                    Download
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !props.canManage || model.selected || !config}
                      onClick={() => {
                        if (config)
                          void mutate((ctx, signal) =>
                            configureEnvironmentSpeech(
                              ctx,
                              { ...config, modelId: model.id },
                              signal,
                            ),
                          );
                      }}
                    >
                      Select
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !props.canManage}
                      onClick={() =>
                        void mutate((ctx, signal) =>
                          removeEnvironmentSpeechModel(ctx, model.id, signal),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
