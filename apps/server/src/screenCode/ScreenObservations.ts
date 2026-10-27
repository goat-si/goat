// @effect-diagnostics nodeBuiltinImport:off - Opaque observation IDs are minted in this host-owned index.
import * as NodeCrypto from "node:crypto";
import type {
  ScreenElementRef,
  ScreenObservation,
  ScreenPointRef,
  ScreenTargetRef,
} from "@goat/contracts";
import type { PreviewAutomationSnapshot } from "@goat/contracts";

// Playwright single-quotes a tree line whose name contains ": ".
const TREE_ROLE = /^(?:-\s*)?'?(\w[\w-]*)/;

export interface ScreenObservationDraft {
  readonly targetRef: ScreenTargetRef;
  readonly targetGeneration: number;
  readonly surfaceGeneration: number;
  readonly indexedText: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly lineage?: string;
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
      editable: Set<string>;
      regions: Map<
        string,
        {
          kind?: "window" | "viewport" | "document" | "element";
          x: number;
          y: number;
          width: number;
          height: number;
          pixelWidth: number;
          pixelHeight: number;
          scale: number;
        }
      >;
    }
  >();

  put(
    targetId: string,
    observationId: string,
    surfaceGeneration: number,
    tokens: Map<string, string>,
    editable: Set<string>,
  ): void {
    this.byTarget.set(targetId, {
      observationId,
      surfaceGeneration,
      tokens,
      editable,
      regions: new Map(),
    });
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
  isEditable(ref: ScreenElementRef): boolean {
    const entry = this.byTarget.get(ref.targetId);
    return (
      entry?.observationId === ref.observationId &&
      entry.surfaceGeneration === ref.surfaceGeneration &&
      entry.editable.has(ref.id)
    );
  }

  putRegion(
    targetId: string,
    observationId: string,
    regionId: string,
    bounds: {
      kind?: "window" | "viewport" | "document" | "element";
      x: number;
      y: number;
      width: number;
      height: number;
      pixelWidth?: number;
      pixelHeight?: number;
      scale?: number;
    },
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
    entry.regions.set(regionId, {
      ...bounds,
      pixelWidth: bounds.pixelWidth ?? bounds.width,
      pixelHeight: bounds.pixelHeight ?? bounds.height,
      scale: bounds.scale ?? 1,
    });
    return true;
  }

  resolvePoint(
    ref: ScreenPointRef,
  ): { targetId: string; x: number; y: number; kind?: "document" } | undefined {
    if (!Number.isFinite(ref.x) || !Number.isFinite(ref.y)) return undefined;
    for (const [targetId, entry] of this.byTarget) {
      if (entry.observationId !== ref.observationId) continue;
      const bounds = entry.regions.get(ref.regionId);
      if (
        !bounds ||
        ref.x < 0 ||
        ref.y < 0 ||
        ref.x >= bounds.pixelWidth ||
        ref.y >= bounds.pixelHeight
      )
        return undefined;
      return {
        targetId,
        x: bounds.x + ref.x / bounds.scale,
        y: bounds.y + ref.y / bounds.scale,
        ...(bounds.kind === "document" ? { kind: "document" as const } : {}),
      };
    }
    return undefined;
  }
  invalidateTarget(targetId: string): void {
    this.byTarget.delete(targetId);
  }
}

export class ScreenObservations {
  readonly index = new ObservationIndex();
  private readonly previous = new Map<
    string,
    { observation: ScreenObservation; draft: ScreenObservationDraft }
  >();

  evictTarget(targetId: string): void {
    this.index.invalidateTarget(targetId);
    this.previous.delete(targetId);
  }

  normalizeAppTree(input: ScreenObservationDraft): ScreenObservationDraft {
    return input;
  }

  normalizeTabSnapshot(input: {
    readonly targetRef: ScreenTargetRef;
    readonly targetGeneration: number;
    readonly connectionId: string;
    readonly controlGeneration: number;
    readonly snapshot: PreviewAutomationSnapshot;
  }): ScreenObservationDraft {
    const { snapshot } = input;
    const tree = typeof snapshot.accessibilityTree === "string" ? snapshot.accessibilityTree : "";
    const lines = tree.split("\n");
    const elements: ScreenObservationDraft["elements"][number][] = [];
    for (const line of lines) {
      const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
      if (!ref) continue;
      const role = line.trim().match(TREE_ROLE)?.[1] ?? "element";
      const name = line.replace(/\[ref=[^\]]+\]/g, "").trim();
      elements.push({ role, name, driverToken: `aria-ref=${ref}` });
    }
    const surfaceGeneration = Number(snapshot.refGeneration);
    const validGeneration = Number.isSafeInteger(surfaceGeneration) && surfaceGeneration >= 0;
    return {
      targetRef: input.targetRef,
      targetGeneration: input.targetGeneration,
      surfaceGeneration: validGeneration ? surfaceGeneration : 0,
      lineage: `${input.connectionId}\u0000${input.controlGeneration}\u0000${snapshot.url}`,
      indexedText: tree,
      complete: snapshot.treeComplete === true && validGeneration,
      truncated: snapshot.treeComplete !== true || !validGeneration,
      loading: snapshot.loading,
      elements: snapshot.treeComplete === true && validGeneration ? elements : [],
    };
  }

  renderObservation(input: {
    draft: ScreenObservationDraft;
    mode: "full" | "diff" | "query";
    baseObservationId?: string;
    query?: { role?: string; name?: string; text?: string };
    /** The draft is already a diff against baseObservationId, made by the driver. */
    prediffed?: boolean;
    /** Why a read the caller asked to diff came back full. */
    resetReason?: string;
    limits: { readonly treeBytes: number };
  }): ScreenObservation {
    const { draft } = input;
    const old = this.previous.get(draft.targetRef.id);
    let mode: ScreenObservation["mode"] = input.mode;
    let resetReason = input.resetReason;
    const currentLines = draft.indexedText.split("\n");
    let selected = draft.elements;
    let renderedText = draft.indexedText;
    let queryTruncated = false;
    if (mode === "query") {
      const query = input.query;
      const lines = currentLines.slice(0, 4096);
      queryTruncated = lines.length < currentLines.length;
      const included = new Set<number>();
      const matchingRefs = new Set<string>();
      const includeWithAncestors = (index: number) => {
        included.add(index);
        const line = lines[index] ?? "";
        let depth = line.length - line.trimStart().length;
        for (let ancestor = index - 1; ancestor >= 0 && depth > 0; ancestor--) {
          const parent = lines[ancestor] ?? "";
          const parentDepth = parent.length - parent.trimStart().length;
          if (parent.trim() && parentDepth < depth) {
            included.add(ancestor);
            depth = parentDepth;
          }
        }
      };
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        const content = line.trim().replace(/^-\s*'?/, "");
        const role = content.match(TREE_ROLE)?.[1] ?? "";
        const name = content
          .slice(role.length)
          .replace(/\[(?:ref=[^\]]+|active|focused)\]/g, "")
          .trim();
        const matches =
          (query?.role === undefined || role.includes(query.role)) &&
          (query?.name === undefined || name.includes(query.name)) &&
          (query?.text === undefined || name.includes(query.text));
        if (matches || /\[(?:active|focused)\]/.test(line)) includeWithAncestors(index);
        if (matches) {
          const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
          if (ref) matchingRefs.add(`aria-ref=${ref}`);
        }
      }
      selected = draft.elements.filter((element) => matchingRefs.has(element.driverToken));
      renderedText = lines.filter((_, index) => included.has(index)).join("\n");
    }
    if (mode === "diff" && !input.prediffed) {
      const valid =
        old &&
        old.observation.observationId === input.baseObservationId &&
        old.observation.complete &&
        !old.observation.truncated &&
        draft.complete &&
        !draft.truncated &&
        old.draft.lineage === draft.lineage &&
        old.draft.targetGeneration === draft.targetGeneration;
      if (valid) {
        const previousLines = old.draft.indexedText.split("\n");
        const key = (line: string) => line.replace(/\[ref=[^\]]+\]/g, "[ref]");
        const oldKeys = previousLines.map(key);
        const newKeys = currentLines.map(key);
        const unique =
          new Set(oldKeys).size === oldKeys.length && new Set(newKeys).size === newKeys.length;
        const removed = previousLines.filter((line) => !newKeys.includes(key(line)));
        const added = currentLines.filter((line) => !oldKeys.includes(key(line)));
        const stableOld = oldKeys.filter((line) => newKeys.includes(line));
        const stableNow = newKeys.filter((line) => oldKeys.includes(line));
        const compact = [
          ...removed.map((line) => `- ${line}`),
          ...added.map((line) => `+ ${line}`),
        ].join("\n");
        if (
          unique &&
          stableOld.join("\n") === stableNow.join("\n") &&
          compact.length < renderedText.length
        ) {
          renderedText = compact;
          selected = draft.elements.filter((element) =>
            added.some((line) => line.includes(`[ref=${element.driverToken.slice(9)}]`)),
          );
        } else resetReason = "reordered_or_longer_diff";
      } else resetReason = "lineage_or_completeness_changed";
      if (resetReason) mode = "full";
    }
    const observationId = NodeCrypto.randomUUID();
    const tokens = new Map<string, string>();
    const editable = new Set<string>();
    const elements = selected.slice(0, 4096).map((element, index) => {
      const id = NodeCrypto.randomUUID();
      tokens.set(id, element.driverToken);
      if (/^(textbox|searchbox|combobox|spinbutton)$/i.test(element.role)) editable.add(id);
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
    let text = Buffer.from(renderedText, "utf8")
      .subarray(0, Math.min(input.limits.treeBytes, 128 * 1024))
      .toString("utf8");
    let truncated =
      draft.truncated ||
      queryTruncated ||
      text.length !== renderedText.length ||
      elements.length !== selected.length;
    const build = (): ScreenObservation => ({
      observationId,
      targetRef: draft.targetRef,
      targetGeneration: draft.targetGeneration,
      surfaceGeneration: draft.surfaceGeneration,
      mode,
      ...(mode === "diff" && input.baseObservationId
        ? { baseObservationId: input.baseObservationId }
        : {}),
      ...(resetReason ? { resetReason } : {}),
      ...(mode === "query" ? { incompleteSearch: !draft.complete || truncated } : {}),
      complete: draft.complete && !truncated,
      loading: draft.loading,
      truncated,
      indexedText: text,
      elements,
    });
    const budget = Math.min(input.limits.treeBytes, 128 * 1024);
    while (Buffer.byteLength(JSON.stringify(build())) > budget && elements.length > 0) {
      const removed = elements.pop();
      if (removed) tokens.delete(removed.ref.id);
      if (removed) editable.delete(removed.ref.id);
      truncated = true;
    }
    while (Buffer.byteLength(JSON.stringify(build())) > budget && text.length > 0) {
      text = text.slice(0, Math.max(0, text.length - 256));
      truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(build())) > budget)
      throw new Error("Screen observation metadata exceeds tree budget");
    this.index.put(draft.targetRef.id, observationId, draft.surfaceGeneration, tokens, editable);
    const observation = build();
    this.previous.set(draft.targetRef.id, { observation, draft });
    return observation;
  }
}
// @effect-diagnostics preferSchemaOverJson:off - This host index measures the complete wire observation before release.
