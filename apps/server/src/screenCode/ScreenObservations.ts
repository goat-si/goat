// @effect-diagnostics nodeBuiltinImport:off - Opaque observation IDs are minted in this host-owned index.
import * as NodeCrypto from "node:crypto";
import type {
  ScreenElementRef,
  ScreenObservation,
  ScreenPointRef,
  ScreenTargetRef,
} from "@goat/contracts";
import type { PreviewAutomationSnapshot } from "@goat/contracts";
import {
  cutDetail,
  cutTreeText,
  desktopCutOrder,
  type Viewport,
} from "./DesktopObservationBudget.ts";

// Playwright single-quotes a tree line whose name contains ": ".
const TREE_ROLE = /^(?:-\s*)?'?(\w[\w-]*)/;
// `role "name" [attribute]...`, then `: text` when the line carries a value.
const TAB_LINE = /^(\w[\w-]*)(?:\s+("(?:[^"\\]|\\.)*"))?((?:\s*\[[^\]]*\])*)\s*(?::\s?(.*))?$/;
const CHECKABLE = /^(?:checkbox|radio|switch|menuitemcheckbox|menuitemradio|option|tab|treeitem)$/;
// Fields whose content is the user's input, never the element's name.
const EDITABLE = /^(?:textbox|searchbox|combobox|spinbutton|slider)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** What a tab observation left out for its size, and how to read it: at most 200 characters. */
const droppedDetail = (indexes: readonly number[]) => {
  const ranges: string[] = [];
  for (let start = 0; start < indexes.length;) {
    let end = start;
    while (end + 1 < indexes.length && indexes[end + 1] === (indexes[end] ?? 0) + 1) end++;
    ranges.push(start === end ? `[${indexes[start]}]` : `[${indexes[start]}]–[${indexes[end]}]`);
    start = end + 1;
  }
  const tail = "; observe({diff:false, scope}) or scroll reads them.";
  let list = ranges.join(", ");
  const head = `Left out ${indexes.length} elements (`;
  const room = 200 - head.length - tail.length - 1;
  if (list.length > room) list = `${list.slice(0, Math.max(0, room - 1))}…`;
  return `${head}${list})${tail}`;
};

/**
 * The first text written under the element on line `at` (a `- text:` line, or the name or value
 * of a line without a ref), when nothing under it has a ref of its own: a container of controls
 * is not named after the help text beside them.
 */
const textUnder = (lines: readonly string[], at: number): string | undefined => {
  const depth = indentOf(lines[at] ?? "");
  let found: string | undefined;
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!line.trim()) continue;
    if (indentOf(line) <= depth) break;
    if (/\[ref=[^\]]+\]/.test(line)) return undefined;
    if (found !== undefined) continue;
    const text = line.trim().match(/^-\s*text:\s?(.*)$/)?.[1];
    const words =
      text === undefined ? tabTreeElement(line).name || tabTreeElement(line).text : scalar(text);
    if (words?.trim()) found = words.trim().slice(0, 1024);
  }
  return found;
};

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
  "actions" | "enabled" | "selected" | "frame" | "range" | "parent" | "id"
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
  /** The window's bounds, for app reads: elements outside them go before visible ones. */
  readonly viewport?: Viewport;
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
      /** Later pages of the same read, by the ref ids each one issued. */
      pageOf: Map<string, string>;
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
      pageOf: new Map(),
      surfaceGeneration,
      tokens,
      editable,
      regions: new Map(),
    });
  }

  /** Adds a later page of the target's current read; false when that read is no longer current. */
  addPage(
    targetId: string,
    baseObservationId: string,
    observationId: string,
    tokens: ReadonlyMap<string, string>,
    editable: ReadonlySet<string>,
  ): boolean {
    const entry = this.byTarget.get(targetId);
    if (!entry || entry.observationId !== baseObservationId) return false;
    for (const [id, token] of tokens) {
      entry.tokens.set(id, token);
      entry.pageOf.set(id, observationId);
    }
    for (const id of editable) entry.editable.add(id);
    return true;
  }
  /** The entry when the ref was issued by that observation: the read, or the page that carried it. */
  private current(ref: ScreenElementRef) {
    const entry = this.byTarget.get(ref.targetId);
    return entry &&
      (entry.pageOf.get(ref.id) ?? entry.observationId) === ref.observationId &&
      entry.surfaceGeneration === ref.surfaceGeneration
      ? entry
      : undefined;
  }
  resolveElement(ref: ScreenElementRef): string | undefined {
    return this.current(ref)?.tokens.get(ref.id);
  }
  isEditable(ref: ScreenElementRef): boolean {
    return this.current(ref)?.editable.has(ref.id) === true;
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
    const scale = bounds.scale ?? 1;
    const pixelWidth = bounds.pixelWidth ?? bounds.width * scale;
    const pixelHeight = bounds.pixelHeight ?? bounds.height * scale;
    entry.regions.set(regionId, {
      ...bounds,
      pixelWidth,
      pixelHeight,
      scale,
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
        x: bounds.x + (ref.x * bounds.width) / bounds.pixelWidth,
        y: bounds.y + (ref.y * bounds.height) / bounds.pixelHeight,
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
    for (const [at, line] of lines.entries()) {
      const ref = line.match(/\[ref=([^\]]+)\]/)?.[1];
      if (!ref) continue;
      const element = tabTreeElement(line);
      // A paragraph, generic box or image whose words are its child text lines is found by them.
      const under =
        element.name === "" && element.text === undefined && !EDITABLE.test(element.role)
          ? textUnder(lines, at)
          : undefined;
      elements.push({
        ...element,
        ...(under === undefined ? {} : { name: under }),
        driverToken: `aria-ref=${ref}`,
      });
    }
    const validGeneration =
      typeof snapshot.refGeneration === "string" && snapshot.refGeneration.length > 0;
    // An incomplete tree (an unread frame, a tree over the text limit) still offers the refs it
    // has when the browser named the document they belong to, so its gate can refuse them later.
    const usable =
      validGeneration &&
      (snapshot.treeComplete === true || typeof input.documentGeneration === "number");
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
      elements: usable ? elements : [],
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
    /** The observation this one continues as a later page of the same read. */
    page?: string;
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
    // An app query or page arrives already filtered by the host.
    if (mode === "query" && draft.targetRef.kind === "tab") {
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
          // The text shows what changed; the elements are every current one, numbered as a full
          // read numbers them, so a name or number found before is found again.
          selected = draft.elements;
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
      const { actions, enabled, selected: isSelected, frame, range, parent, id: axId } = element;
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
        ...(axId === undefined ? {} : { id: axId.slice(0, 400) }),
        ref: {
          id,
          targetId: draft.targetRef.id,
          observationId,
          surfaceGeneration: draft.surfaceGeneration,
        },
      };
    });
    // A tab's tree names elements by Playwright ref; show the same numbers an app's tree shows,
    // only for elements the observation still carries, so every number shown has a ref.
    const numbers = new Map(
      selected.slice(0, 4096).map((element, position) => [element.driverToken, position]),
    );
    const numbered = (carried: ReadonlySet<string>) =>
      draft.targetRef.kind !== "tab"
        ? renderedText
        : renderedText.replace(/ ?\[ref=([^\]]+)\]/g, (_marker, ref: string) => {
            const token = `aria-ref=${ref}`;
            const number = numbers.get(token);
            return number === undefined || !carried.has(token) ? "" : ` [${number}]`;
          });
    const cut = (value: string) =>
      Buffer.from(value, "utf8")
        .subarray(0, Math.min(input.limits.treeBytes, 128 * 1024))
        .toString("utf8");
    const fullText = numbered(new Set(numbers.keys()));
    let text = cut(fullText);
    let title = draft.title === undefined ? undefined : draft.title.slice(0, 1024);
    let truncated =
      draft.truncated ||
      queryTruncated ||
      text.length !== fullText.length ||
      elements.length !== selected.length;
    const dropped: number[] = [];
    const omittedNow = () =>
      [
        ...(draft.omitted ?? []),
        ...(dropped.length > 0 && draft.targetRef.kind === "tab"
          ? [{ kind: "budget" as const, detail: droppedDetail(dropped) }]
          : []),
        ...(dropped.length > 0 && draft.targetRef.kind === "app"
          ? [{ kind: "budget" as const, detail: cutDetail(dropped, Math.min(...dropped)) }]
          : []),
        ...(truncated &&
        !draft.omitted?.some((item) => item.kind === "budget") &&
        dropped.length === 0
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
      ...(title === undefined ? {} : { title }),
      ...(draft.url === undefined ? {} : { url: draft.url }),
      truncated,
      indexedText: text,
      elements,
    });
    const budget = Math.min(input.limits.treeBytes, 128 * 1024);
    // An app read over budget gives up redundant annotations, then elements in the order
    // desktopCutOrder plans (chrome outlasts table body, visible outlasts off-window).
    if (
      draft.targetRef.kind === "app" &&
      Buffer.byteLength(JSON.stringify(build())) > budget &&
      title !== undefined
    ) {
      title = undefined;
      truncated = true;
    }
    if (draft.targetRef.kind === "app" && Buffer.byteLength(JSON.stringify(build())) > budget) {
      const plain = renderedText.replace(/ actions=\[[^\]]*\]/g, "").replace(/ \[\]/g, "");
      text = cut(plain);
      const cutPlan = desktopCutOrder(elements, draft.indexedText, draft.viewport);
      const sizes = new Map(
        elements.map((element) => [element.index, Buffer.byteLength(JSON.stringify(element)) + 1]),
      );
      const parents = new Map(
        elements.flatMap((element) =>
          element.parent === undefined ? [] : [[element.index, element.parent] as const],
        ),
      );
      const words = new Map(
        elements.map((element) => [element.index, element.name || element.text || ""]),
      );
      const gone = new Set<number>();
      let next = 0;
      // Elements may use what the text leaves, keeping at most 40% of the budget for the text;
      // the text is trimmed after, so elements are never all spent on a long text.
      const textShare = Math.min(Buffer.byteLength(text), Math.floor(budget * 0.4));
      const withoutText = () => Buffer.byteLength(JSON.stringify({ ...build(), indexedText: "" }));
      while (withoutText() > budget - textShare && next < cutPlan.order.length) {
        let need = withoutText() - (budget - textShare);
        while (need > 0 && next < cutPlan.order.length) {
          const index = cutPlan.order[next++];
          if (index === undefined) continue;
          gone.add(index);
          need -= sizes.get(index) ?? 0;
        }
        for (let at = elements.length - 1; at >= 0; at--) {
          const element = elements[at];
          if (!element || !gone.has(element.index)) continue;
          elements.splice(at, 1);
          tokens.delete(element.ref.id);
          editable.delete(element.ref.id);
          dropped.push(element.index);
        }
        // A kept element whose parent went points at its nearest kept ancestor.
        for (const [at, element] of elements.entries()) {
          let parent = element.parent;
          while (parent !== undefined && gone.has(parent)) parent = parents.get(parent);
          if (parent !== element.parent) {
            const { parent: _old, ...rest } = element;
            elements[at] = parent === undefined ? rest : { ...rest, parent };
          }
        }
        text = cut(
          cutTreeText(plain, gone, cutPlan.compactRows, (index) => words.get(index) ?? ""),
        );
        truncated = true;
      }
    }
    // For an app read, text over budget is trimmed below instead of costing elements; any element
    // still given up loses its number from the text.
    const app = draft.targetRef.kind === "app";
    const measured = () =>
      Buffer.byteLength(JSON.stringify(app ? { ...build(), indexedText: "" } : build()));
    while (measured() > budget && elements.length > 0) {
      const removed = elements.pop();
      if (removed) tokens.delete(removed.ref.id);
      if (removed) editable.delete(removed.ref.id);
      if (removed) dropped.unshift(removed.index);
      truncated = true;
    }
    if (app) {
      const carried = new Set(elements.map((element) => element.index));
      text = text.replace(/- \[(\d+)\] /g, (marker, number: string) =>
        carried.has(Number(number)) ? marker : "- ",
      );
    }
    if (dropped.length > 0 && draft.targetRef.kind === "tab")
      text = cut(numbered(new Set(tokens.values())));
    while (Buffer.byteLength(JSON.stringify(build())) > budget && text.length > 0) {
      text = text.slice(0, Math.max(0, text.length - 256));
      truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(build())) > budget && title !== undefined) {
      title = undefined;
      truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(build())) > budget)
      throw new Error("Screen observation metadata exceeds tree budget");
    const observation = build();
    if (input.page !== undefined) {
      if (!this.index.addPage(draft.targetRef.id, input.page, observationId, tokens, editable))
        throw new Error("Screen observation page outlived its read");
      return observation;
    }
    this.index.put(draft.targetRef.id, observationId, draft.surfaceGeneration, tokens, editable);
    this.previous.set(draft.targetRef.id, { observation, draft });
    return observation;
  }
}
// @effect-diagnostics preferSchemaOverJson:off - This host index measures the complete wire observation before release.
