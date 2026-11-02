import type { CDPSession } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { capturePaint, occludedRefs } from "./paintOcclusion.ts";

const DEFAULTS: Readonly<Record<string, string>> = {
  "background-color": "rgba(0, 0, 0, 0)",
  opacity: "1",
  visibility: "visible",
  "background-clip": "border-box",
  "mix-blend-mode": "normal",
  "overflow-x": "visible",
  "overflow-y": "visible",
  clip: "auto",
  contain: "none",
};

/** The style order capturePaint asks the browser for, read from its own request. */
const requestedStyles = async () => {
  let order: ReadonlyArray<string> = [];
  const cdp = {
    send: async (_method: string, params: { readonly computedStyles: ReadonlyArray<string> }) => {
      order = params.computedStyles;
    },
  };
  await capturePaint(cdp as unknown as CDPSession);
  return order;
};

type Node = {
  readonly parent: number;
  readonly bounds: ReadonlyArray<number>;
  readonly paintOrder: number;
  readonly background?: string;
};

const snapshotOf = (order: ReadonlyArray<string>, nodes: ReadonlyArray<Node>) => {
  const strings: Array<string> = [];
  const at = (value: string) =>
    strings.includes(value) ? strings.indexOf(value) : strings.push(value) - 1;
  const style = (node: Node) =>
    order.map((name) =>
      at(
        name === "background-color" && node.background
          ? node.background
          : (DEFAULTS[name] ?? (name.endsWith("radius") ? "0px" : "none")),
      ),
    );
  return {
    strings,
    documents: [
      {
        scrollOffsetX: 0,
        scrollOffsetY: 0,
        nodes: {
          parentIndex: nodes.map((node) => node.parent),
          nodeType: nodes.map(() => 1),
          nodeName: nodes.map(() => at("DIV")),
        },
        layout: {
          nodeIndex: nodes.map((_node, index) => index),
          bounds: nodes.map((node) => node.bounds),
          clientRects: nodes.map((node) => [0, 0, node.bounds[2], node.bounds[3]]),
          paintOrders: nodes.map((node) => node.paintOrder),
          styles: nodes.map(style),
        },
      },
    ],
  };
};

const page = { parent: -1, bounds: [0, 0, 800, 600], paintOrder: 0 };
const white = "rgb(255, 255, 255)";

it("marks a ref an opaque later-painted box covers, and none from a malformed snapshot", async () => {
  const order = await requestedStyles();
  const button = { parent: 0, bounds: [10, 10, 50, 20], paintOrder: 1 };
  const cover = { parent: 0, bounds: [0, 0, 100, 100], paintOrder: 2, background: white };
  const tree = "- button [ref=e2] [box=10,10,50,20]";
  const valid = snapshotOf(order, [page, button, cover]);
  expect(occludedRefs(valid, tree)).toEqual(new Set(["e2"]));
  const [document] = valid.documents;
  if (document === undefined) throw new Error("no document");
  const malformed: ReadonlyArray<unknown> = [
    undefined,
    { result: { value: "evaluated" } },
    { ...valid, documents: [{ ...document, layout: undefined }] },
    { ...valid, documents: [{ ...document, scrollOffsetY: Number.NaN }] },
    {
      ...valid,
      documents: [{ ...document, nodes: { ...document.nodes, parentIndex: [-1, 0, 2] } }],
    },
    {
      ...valid,
      documents: [
        {
          ...document,
          layout: {
            ...document.layout,
            bounds: [
              [0, 0, 800, 600],
              [10, 10, Number.NaN, 20],
              [0, 0, 100, 100],
            ],
          },
        },
      ],
    },
    {
      ...valid,
      documents: [
        {
          ...document,
          layout: {
            ...document.layout,
            styles: document.layout.styles.map((indexes) => indexes.map(() => 999)),
          },
        },
      ],
    },
  ];
  for (const shot of malformed) expect(occludedRefs(shot, tree)).toEqual(new Set());
});

it("tests coverage on a ref's unrounded box, so a cover short of its fractional edge leaves it unmarked", async () => {
  const order = await requestedStyles();
  const button = { parent: 0, bounds: [10.49, 10.49, 10.49, 10.49], paintOrder: 1 };
  const tree = "- button [ref=e2] [box=10,10,10,10]";
  const coverTo = (edge: number) => ({
    parent: 0,
    bounds: [0, 0, edge, edge],
    paintOrder: 2,
    background: white,
  });
  expect(occludedRefs(snapshotOf(order, [page, button, coverTo(20.5)]), tree)).toEqual(new Set());
  expect(occludedRefs(snapshotOf(order, [page, button, coverTo(21)]), tree)).toEqual(
    new Set(["e2"]),
  );
});
