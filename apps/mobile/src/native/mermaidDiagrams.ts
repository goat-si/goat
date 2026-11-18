import type { DiagramType } from "pele/lazy";

type Pele = typeof import("pele/lazy");
export type Diagram =
  | {
      readonly status: "ready";
      readonly svg: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly status: "error"; readonly message: string };

let peleLoad: Promise<Pele | null> | null = null;
// Each diagram type is its own chunk, so a thread with one flowchart only
// evaluates the flowchart parser and layout.
const typeLoads = new Map<DiagramType, Promise<boolean>>();
// A message scrolled back into view reuses its settled promise, which `use`
// reads without suspending, instead of flashing the source.
const diagramLoads = new Map<string, Promise<Diagram>>();
const DIAGRAM_CACHE_LIMIT = 64;

export function loadDiagram(source: string): Promise<Diagram> {
  let load = diagramLoads.get(source);
  if (!load) {
    if (diagramLoads.size >= DIAGRAM_CACHE_LIMIT) {
      const oldest = diagramLoads.keys().next();
      if (!oldest.done) diagramLoads.delete(oldest.value);
    }
    load = renderDiagram(source);
    diagramLoads.set(source, load);
  }
  return load;
}

async function renderDiagram(source: string): Promise<Diagram> {
  peleLoad ??= import("pele/lazy").catch(() => null);
  const pele = await peleLoad;
  if (!pele) {
    // Not cached, so the next mount tries again.
    peleLoad = null;
    diagramLoads.delete(source);
    return { status: "error", message: "The diagram renderer failed to load." };
  }
  let type: DiagramType | null = null;
  try {
    type = pele.detectType(source);
  } catch {
    // An unknown type falls through to render, which reports why.
  }
  if (type) {
    let load = typeLoads.get(type);
    if (!load) {
      load = pele.load(type).then(
        () => true,
        () => false,
      );
      typeLoads.set(type, load);
    }
    if (!(await load)) {
      typeLoads.delete(type);
      diagramLoads.delete(source);
      return { status: "error", message: "The diagram renderer failed to load." };
    }
  }
  try {
    const { svg, width, height } = pele.render(source, {
      links: false,
      images: false,
      // Keep the author's direction; a wide diagram scales down to fit instead of turning vertical.
      autoDirection: false,
    });
    return { status: "ready", svg, width, height };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "The diagram could not be rendered.",
    };
  }
}
