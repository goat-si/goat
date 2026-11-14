import {
  AuthVoiceManageScope,
  AuthFilesystemReadScope,
  type EnvironmentId,
  type SpeechConfiguration,
  type SpeechModelList,
  speechBenchmarkTiers,
} from "@goat/contracts";
import {
  configureEnvironmentSpeech,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechConfiguration,
  listEnvironmentSpeechModels,
  linkEnvironmentSpeechModels,
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

import { filterSpeechModels } from "./speechModelBrowser";

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
  const [linkPath, setLinkPath] = useState("");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [sorting, setSorting] = useState<{
    environmentId: EnvironmentId;
    value: "recommended" | "size" | "name" | "speed-cpu" | "speed-gpu";
  }>({ environmentId: props.environmentId, value: "recommended" });
  const [snapshot, setSnapshot] = useState<{
    environmentId: EnvironmentId;
    models: readonly Model[];
    config: SpeechConfiguration;
    supportsModelLinking: boolean;
  } | null>(null);
  const models = snapshot?.environmentId === props.environmentId ? snapshot.models : [];
  const config = snapshot?.environmentId === props.environmentId ? snapshot.config : null;
  const canLink =
    snapshot?.environmentId === props.environmentId &&
    snapshot.supportsModelLinking &&
    readEnvironmentScope(props.environmentId, AuthFilesystemReadScope);
  const tiers = speechBenchmarkTiers(config?.acceleration);
  const selectedSort =
    sorting.environmentId === props.environmentId ? sorting.value : "recommended";
  const sort =
    (selectedSort === "speed-cpu" && !tiers.includes("cpu")) ||
    (selectedSort === "speed-gpu" && !tiers.includes("accelerated"))
      ? "recommended"
      : selectedSort;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useStableCallback(async (signal: AbortSignal) => {
    const environmentId = props.environmentId;
    if (!props.canManage || !readEnvironmentScope(environmentId, AuthVoiceManageScope))
      throw new Error("This connection cannot manage voice models.");
    const context = await props.resolveContext(environmentId);
    signal.throwIfAborted();
    if (!context || !readEnvironmentScope(environmentId, AuthVoiceManageScope))
      throw new Error("Connect to an environment with voice management permission.");
    const [list, current] = await Promise.all([
      listEnvironmentSpeechModels(context, signal),
      getEnvironmentSpeechConfiguration(context, signal),
    ]);
    signal.throwIfAborted();
    setSnapshot({
      environmentId,
      models: list.models,
      config: current,
      supportsModelLinking: list.supportsModelLinking === true,
    });
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A destination change must cancel and reload the model list.
  }, [props.open, props.canManage, props.environmentId, refresh]);

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
          {error ? <p role="alert">{error}</p> : null}
          {busy ? <p role="status">Updating voice model…</p> : null}
          {canLink ? (
            <div>
              <label>
                Existing model file or folder on {props.label}{" "}
                <input value={linkPath} onChange={(event) => setLinkPath(event.target.value)} />
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !props.canManage || !linkPath.trim()}
                onClick={() =>
                  void mutate((ctx, signal) =>
                    linkEnvironmentSpeechModels(ctx, linkPath.trim(), signal),
                  )
                }
              >
                Use existing models
              </Button>
            </div>
          ) : null}
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
                if (
                  value === "recommended" ||
                  value === "size" ||
                  value === "name" ||
                  value === "speed-cpu" ||
                  value === "speed-gpu"
                )
                  setSorting({ environmentId: props.environmentId, value });
              }}
            >
              <option value="recommended">Recommended</option>
              <option value="size">Size</option>
              <option value="name">Name</option>
              <option value="speed-cpu" disabled={!tiers.includes("cpu")}>
                Speed (CPU reference)
              </option>
              <option value="speed-gpu" disabled={!tiers.includes("accelerated")}>
                Speed (GPU reference)
              </option>
            </select>
          </label>
          {filterSpeechModels(
            models,
            search,
            installedOnly,
            sort === "speed-cpu" || sort === "speed-gpu" ? "speed" : sort,
            sort === "speed-cpu" ? "cpu" : sort === "speed-gpu" ? "accelerated" : undefined,
          ).map((model) => (
            <div key={model.id} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p>
                  {model.name}
                  {model.selected ? " (selected)" : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  {model.description} · {(model.size / 1_000_000_000).toFixed(1)} GB
                </p>
                {model.linkedFrom ? (
                  <p className="text-xs text-muted-foreground">Using {model.linkedFrom}</p>
                ) : null}
                {model.benchmark ? (
                  <p className="text-xs text-muted-foreground">
                    Reference time for 30 s:{" "}
                    {tiers.map((tier, index) => (
                      <span key={tier}>
                        {index ? " · " : ""}
                        {tier === "cpu" ? "CPU" : "GPU"}{" "}
                        {model.benchmark?.[tier] == null
                          ? "not benchmarked"
                          : `${model.benchmark[tier]} s`}
                      </span>
                    ))}
                  </p>
                ) : null}
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
