const MAX_REPORTED_MODELS = 128;

export function createClaudeReportedContext() {
  const windows = new Map<string, number>();
  return {
    get: (model: string) => windows.get(model),
    record: (modelUsage: unknown): boolean => {
      if (typeof modelUsage !== "object" || modelUsage === null) return false;
      let changed = false;
      for (const [model, entry] of Object.entries(modelUsage)) {
        if (typeof entry !== "object" || entry === null || model.length > 256) continue;
        const value = Reflect.get(entry, "contextWindow");
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1) continue;
        const window = Math.round(value);
        if (windows.get(model) === window) continue;
        if (!windows.has(model) && windows.size >= MAX_REPORTED_MODELS) continue;
        windows.set(model, window);
        changed = true;
      }
      return changed;
    },
  };
}
