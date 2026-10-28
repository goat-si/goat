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
// `role "name" [attribute]...`, then `: text` when the line carries a value.
const TAB_LINE = /^(\w[\w-]*)(?:\s+("(?:[^"\\]|\\.)*"))?((?:\s*\[[^\]]*\])*)\s*(?::\s?(.*))?$/;
const CHECKABLE = /^(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio|option|tab|treeitem)$/;

/** A YAML scalar as Playwright writes it: plain, double-quoted (JSON) or single-quoted. */
const scalar = (value: string): string => {
  if (value.startsWith('"'))
    try {
      return String(JSON.parse(value));
    } catch {
      return value;
    }
  return value.startsWith("'") && value.endsWith("'") && value.length > 1
    ? value.slice(1, -1).replaceAll("''", "'")
    : value;
};

/** One tab tree line as an element's role, name, value and state, read the same in every mode. */
const tabTreeElement = (
  line: string,
): Pick<
  ScreenObservationDraft["elements"][number],
  "role" | "name" | "text" | "enabled" | "selected"
> => {
  let body = line.trim().replace(/^-\s*/, "");
  let tail: string | undefined;
  if (body.startsWith("'")) {
    // A quoted key doubles its own single quotes; its value follows the closing quote.
    let end = 1;
    let inner = "";
    for (; end < body.length; end++) {
      if (body[end] !== "'") inner += body[end];
      else if (body[end + 1] === "'") inner += body[++end];
      else break;
    }
    tail = body.slice(end + 1).match(/^\s*:\s?(.*)$/)?.[1];
    body = inner;
  }
  const parsed = TAB_LINE.exec(body);
  if (!parsed)
    return {
      role: line.trim().match(TREE_ROLE)?.[1] ?? "element",
      name: line.replace(/\[ref=[^\]]+\]/g, "").trim(),
    };
  const [, role = "element", quotedName, attributeText = "", plainText] = parsed;
  const attributes = new Set([...attributeText.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]));
  const value = scalar((tail ?? plainText ?? "").trim());
  const on = ["checked", "selected", "pressed"].some((name) => attributes.has(name));
  const mixed = attributes.has("checked=mixed") || attributes.has("pressed=mixed");
  return {
    role,
    name: quotedName === undefined ? "" : scalar(quotedName),
    ...(value === "" ? {} : { text: value }),
    ...(attributes.has("disabled") ? { enabled: false } : {}),
    ...(on ? { selected: true } : !mixed && CHECKABLE.test(role) ? { selected: false } : {}),
  };
};

/** State and geometry a driver reports for an element; carried to the agent unchanged. */
export type ScreenElementDetail = Pick<
  ScreenObservation["elements"][number],
  "actions" | "enabled" | "selected" | "frame" | "range" | "parent"
>;

export interface ScreenObservationDraft {
  readonly targetRef: ScreenTargetRef;
  readonly targetGeneration: number;
  readonly surfaceGeneration: number;
  readonly indexedText: string;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly title?: string;
  readonly url?: string;
  readonly lineage?: string;
  /** Regions the source left out, such as frames it could not read. */
  readonly omitted?: NonNullable<ScreenObservation["omitted"]>;
  readonly elements: readonly ({
    readonly role: string;
    readonly name: string;
    readonly text?: string;
    readonly driverToken: string;
    /** The number the tree text shows for this element; its position when absent. */
    readonly index?: number;
  } & ScreenElementDetail)[];
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
  /** Screenshot points name pixels, which any input can scroll or replace; element refs remain. */
  invalidatePoints(targetId: string): void {
    this.byTarget.get(targetId)?.regions.clear();
  }
}

export class ScreenObservations {
  readonly index = new ObservationIndex();
  private nextTabGeneration = 0;
  private readonly tabGenerations = new Map<string, { key: string; generation: number }>();
  private readonly previous = new Map<
    string,
    { observation: ScreenObservation; draft: ScreenObservationDraft }
  >();

  evictTarget(targetId: string): void {
    this.index.invalidateTarget(targetId);
    this.previous.delete(targetId);
    this.tabGenerations.delete(targetId);
  }

  normalizeAppTree(input: ScreenObservationDraft): ScreenObservationDraft {
    return input;
  }

  normalizeTabSnapshot(input: {
    readonly targetRef: ScreenTargetRef;
    readonly targetGeneration: number;
    readonly connectionId: string;
    readonly controlGeneration: number;
    /** The main-frame document the browser reported; a reload with the same URL moves it. */
    readonly documentGeneration?: number;
    readonly snapshot: PreviewAutomationSnapshot;
  }): ScreenObservationDraft {
    const { snapshot } = input;
    const tree = typeof snapshot.accessibilityTree === "string" ? snapshot.accessibilityTree : "";
    const lines = tree.split("\n");
    const elements: ScreenObservationDraft["elements"][number][] = [];
    for (const line of lines) {
      const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
      if (!ref) continue;
      elements.push({ ...tabTreeElement(line), driverToken: `aria-ref=${ref}` });
    }
    const validGeneration =
      typeof snapshot.refGeneration === "string" && snapshot.refGeneration.length > 0;
    const key = JSON.stringify([
      input.connectionId,
      input.controlGeneration,
      snapshot.refGeneration,
    ]);
    let generation = this.tabGenerations.get(input.targetRef.id);
    if (!generation || generation.key !== key) {
      generation = { key, generation: ++this.nextTabGeneration };
      this.tabGenerations.set(input.targetRef.id, generation);
    }
    return {
      targetRef: input.targetRef,
      targetGeneration: input.targetGeneration,
      surfaceGeneration: generation.generation,
      lineage: `${input.connectionId}\u0000${input.controlGeneration}\u0000${input.documentGeneration ?? ""}\u0000${snapshot.url}`,
      indexedText: tree,
      complete: snapshot.treeComplete === true && validGeneration,
      truncated: snapshot.treeComplete !== true || !validGeneration,
      loading: snapshot.loading,
      title: snapshot.title.slice(0, 1024),
      url: snapshot.url.slice(0, 8192),
      ...(snapshot.omitted === undefined || snapshot.omitted.length === 0
        ? {}
        : {
            omitted: snapshot.omitted.map((reason) =>
              reason === "unread_frames"
                ? { kind: "frames" as const }
                : { kind: "budget" as const, detail: reason },
            ),
          }),
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
    /** What the read covered; omitted means the whole window or page. */
    scope?: string;
    limits: { readonly treeBytes: number };
  }): ScreenObservation {
    const { draft } = input;
    const old = this.previous.get(draft.targetRef.id);
    let mode: ScreenObservation["mode"] = input.mode;
    let resetReason = input.resetReason;
    const currentLines = draft.indexedText.split("\n");
    const scope = input.scope ?? (draft.targetRef.kind === "app" ? "window" : "page");
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
    // A diff against a read of another scope would report filtered rows as removed.
    if (mode === "diff" && !input.prediffed && old && old.observation.scope !== scope) {
      mode = "full";
      resetReason = "scope_changed";
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
    const elements = selected.slice(0, 4096).map((element, position) => {
      const id = NodeCrypto.randomUUID();
      tokens.set(id, element.driverToken);
      if (/^(textbox|searchbox|combobox|spinbutton)$/i.test(element.role)) editable.add(id);
      const { actions, enabled, selected: isSelected, frame, range, parent } = element;
      return {
        index: element.index ?? position,
        role: element.role.slice(0, 200),
        name: element.name.slice(0, 1024),
        ...(element.text === undefined ? {} : { text: element.text.slice(0, 4096) }),
        ...(actions === undefined
          ? {}
          : { actions: actions.slice(0, 16).map((action) => action.slice(0, 80)) }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(isSelected === undefined ? {} : { selected: isSelected }),
        ...(frame === undefined ? {} : { frame }),
        ...(range === undefined ? {} : { range }),
        ...(parent === undefined ? {} : { parent }),
        ref: {
          id,
          targetId: draft.targetRef.id,
          observationId,
          surfaceGeneration: draft.surfaceGeneration,
        },
      };
    });
    // A tab's tree names elements by Playwright ref; show the same numbers an app's tree shows.
    if (draft.targetRef.kind === "tab") {
      const numbers = new Map(
        selected.slice(0, 4096).map((element, position) => [element.driverToken, position]),
      );
      renderedText = renderedText.replace(/ ?\[ref=([^\]]+)\]/g, (marker, ref: string) => {
        const number = numbers.get(`aria-ref=${ref}`);
        return number === undefined ? "" : ` [${number}]`;
      });
    }
    let text = Buffer.from(renderedText, "utf8")
      .subarray(0, Math.min(input.limits.treeBytes, 128 * 1024))
      .toString("utf8");
    let truncated =
      draft.truncated ||
      queryTruncated ||
      text.length !== renderedText.length ||
      elements.length !== selected.length;
    const omittedNow = () =>
      [
        ...(draft.omitted ?? []),
        ...(truncated && !draft.omitted?.some((item) => item.kind === "budget")
          ? [{ kind: "budget" as const }]
          : []),
      ].slice(0, 16);
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
      scope,
      ...(omittedNow().length === 0 ? {} : { omitted: omittedNow() }),
      ...(mode === "query" ? { incompleteSearch: !draft.complete || truncated } : {}),
      complete: draft.complete && !truncated,
      loading: draft.loading,
      ...(draft.title === undefined ? {} : { title: draft.title }),
      ...(draft.url === undefined ? {} : { url: draft.url }),
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
