// @effect-diagnostics nodeBuiltinImport:off - Opaque observation IDs are minted in this host-owned index.
import { randomUUID } from "node:crypto";
import type {
  ScreenElementRef,
  ScreenObservation,
  ScreenPointRef,
  ScreenTargetRef,
} from "@goat/contracts";

export interface ScreenObservationDraft {
  readonly targetRef: ScreenTargetRef;
  readonly targetGeneration: number;
  readonly surfaceGeneration: number;
  readonly indexedText: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly elements: readonly {
    readonly role: string;
    readonly name: string;
    readonly text?: string;
    readonly driverToken: string;
  }[];
}

class ObservationIndex {
  private readonly byTarget = new Map<
    string,
    {
      observationId: string;
      surfaceGeneration: number;
      tokens: Map<string, string>;
      regions: Map<string, { x: number; y: number; width: number; height: number }>;
    }
  >();

  put(
    targetId: string,
    observationId: string,
    surfaceGeneration: number,
    tokens: Map<string, string>,
  ): void {
    this.byTarget.set(targetId, { observationId, surfaceGeneration, tokens, regions: new Map() });
  }

  resolveElement(ref: ScreenElementRef): string | undefined {
    const entry = this.byTarget.get(ref.targetId);
    if (
      !entry ||
      entry.observationId !== ref.observationId ||
      entry.surfaceGeneration !== ref.surfaceGeneration
    )
      return undefined;
    return entry.tokens.get(ref.id);
  }

  putRegion(
    targetId: string,
    observationId: string,
    regionId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ): boolean {
    const entry = this.byTarget.get(targetId);
    if (
      !entry ||
      entry.observationId !== observationId ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 ||
      bounds.height <= 0
    )
      return false;
    entry.regions.set(regionId, bounds);
    return true;
  }

  resolvePoint(ref: ScreenPointRef): { targetId: string; x: number; y: number } | undefined {
    if (!Number.isFinite(ref.x) || !Number.isFinite(ref.y)) return undefined;
    for (const [targetId, entry] of this.byTarget) {
      if (entry.observationId !== ref.observationId) continue;
      const bounds = entry.regions.get(ref.regionId);
      if (
        !bounds ||
        ref.x < bounds.x ||
        ref.y < bounds.y ||
        ref.x >= bounds.x + bounds.width ||
        ref.y >= bounds.y + bounds.height
      )
        return undefined;
      return { targetId, x: ref.x, y: ref.y };
    }
    return undefined;
  }
  invalidateTarget(targetId: string): void {
    this.byTarget.delete(targetId);
  }
}

export class ScreenObservations {
  readonly index = new ObservationIndex();

  normalizeAppTree(input: ScreenObservationDraft): ScreenObservationDraft {
    return input;
  }

  renderObservation(input: {
    draft: ScreenObservationDraft;
    mode: "full";
    limits: { readonly treeBytes: number };
  }): ScreenObservation {
    const { draft } = input;
    const observationId = randomUUID();
    const tokens = new Map<string, string>();
    const elements = draft.elements.slice(0, 4096).map((element, index) => {
      const id = randomUUID();
      tokens.set(id, element.driverToken);
      return {
        index,
        role: element.role.slice(0, 200),
        name: element.name.slice(0, 1024),
        ...(element.text === undefined ? {} : { text: element.text.slice(0, 4096) }),
        ref: {
          id,
          targetId: draft.targetRef.id,
          observationId,
          surfaceGeneration: draft.surfaceGeneration,
        },
      };
    });
    let text = Buffer.from(draft.indexedText, "utf8")
      .subarray(0, Math.min(input.limits.treeBytes, 128 * 1024))
      .toString("utf8");
    let truncated =
      draft.truncated ||
      text.length !== draft.indexedText.length ||
      elements.length !== draft.elements.length;
    const build = (): ScreenObservation => ({
      observationId,
      targetRef: draft.targetRef,
      targetGeneration: draft.targetGeneration,
      surfaceGeneration: draft.surfaceGeneration,
      mode: "full",
      complete: draft.complete,
      loading: draft.loading,
      truncated,
      indexedText: text,
      elements,
    });
    const budget = Math.min(input.limits.treeBytes, 128 * 1024);
    while (Buffer.byteLength(JSON.stringify(build())) > budget && elements.length > 0) {
      const removed = elements.pop();
      if (removed) tokens.delete(removed.ref.id);
      truncated = true;
    }
    while (Buffer.byteLength(JSON.stringify(build())) > budget && text.length > 0) {
      text = text.slice(0, Math.max(0, text.length - 256));
      truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(build())) > budget)
      throw new Error("Screen observation metadata exceeds tree budget");
    this.index.put(draft.targetRef.id, observationId, draft.surfaceGeneration, tokens);
    return build();
  }
}
// @effect-diagnostics preferSchemaOverJson:off - This host index measures the complete wire observation before release.
