export function liveSpeechAvailable(
  config:
    | { readonly speechStreamingV1?: boolean; readonly speechStreamingModelIds?: readonly string[] }
    | null
    | undefined,
  modelId: string | undefined,
): boolean {
  return (
    config?.speechStreamingV1 === true &&
    modelId !== undefined &&
    config.speechStreamingModelIds?.includes(modelId) === true
  );
}
