import type { ScreenHostCall, ScreenRunError, ScreenTargetRef } from "@goat/contracts";
import type { BoundPreviewTab } from "./BoundPreviewTabs.ts";

export const fail = (code: ScreenRunError["code"], nextStep: string): ScreenRunError => ({
  code,
  effectStarted: false,
  nextStep,
});
export const firstArg = (call: ScreenHostCall): Record<string, unknown> => {
  const value = Array.isArray(call.args) ? call.args[0] : undefined;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};
export const stringField = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === "string" ? (record[key] as string) : undefined;
export interface BoundTarget {
  readonly ref: ScreenTargetRef;
  readonly tab: BoundPreviewTab;
  readonly origin: string | null;
  readonly observationId?: string;
  /** The document the latest observation saw, when the host reports one; points belong to it. */
  readonly documentGeneration?: number;
  /** The latest observation, when its tree was incomplete: its refs are held to its document. */
  readonly incompleteObservationId?: string;
  readonly screenshotBasis?: {
    readonly documentGeneration?: number;
    readonly viewport: { readonly width: number; readonly height: number };
    readonly viewportReported: boolean;
  };
}
