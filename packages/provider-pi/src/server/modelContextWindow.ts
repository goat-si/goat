import { piRecordNumber as recordNumber, piRecordString as recordString } from "./rpc.ts";

export const nonNegativeInteger = (input: unknown, key: string): number | undefined => {
  const value = recordNumber(input, key);
  return value === undefined ? undefined : Math.max(0, Math.trunc(value));
};

export const rememberPiModelContextWindow = (
  modelContextWindows: Map<string, number>,
  model: unknown,
): number | null => {
  const provider = recordString(model, "provider");
  const id = recordString(model, "id");
  const capacity = nonNegativeInteger(model, "contextWindow");
  if (provider !== undefined && id !== undefined && capacity !== undefined && capacity > 0) {
    modelContextWindows.set(`${provider}/${id}`, capacity);
    return capacity;
  }
  return null;
};
