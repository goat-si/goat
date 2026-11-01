import { describe, expect, it } from "vite-plus/test";
import { admitDesktopInput, type GuardElement } from "./DesktopInputGuards.ts";

const kakao = { appId: "KakaoTalk", bundleId: "com.kakao.KakaoTalkMac" };
const editor = { appId: "Editor", bundleId: "org.example.Editor" };
const element = (role: string, name: string, index: number): GuardElement => ({
  index,
  role,
  name,
  rawLabel: name,
  nonValueLabel: name,
  description: "",
  placeholder: "",
  subrole: "",
  identifier: "",
  editable: false,
  editingCell: false,
  tableCell: false,
  menuSurface: false,
});
const sendButton = element("AXButton", "Send", 4);

/** Each GOAT guard family, as one call that strict mode refuses before anything is sent. */
const GUARDED: ReadonlyArray<readonly [string, Parameters<typeof admitDesktopInput>[0]]> = [
  ["chat point click", { method: "click", args: { x: 10, y: 10 }, ...kakao }],
  ["chat drag", { method: "drag", args: { from_x: 1, from_y: 1, to_x: 5, to_y: 5 }, ...kakao }],
  ["untargeted Enter in a chat", { method: "press_key", args: { key: "Enter" }, ...kakao }],
  [
    "chat send button",
    {
      method: "click",
      args: {},
      ...kakao,
      elementToken: "s:4",
      element: sendButton,
      placed: { frame: { x: 1, y: 1, w: 20, h: 10 } },
      windowBounds: { x: 0, y: 0, w: 400, h: 300 },
    },
  ],
  ["paste shortcut", { method: "press_key", args: { key: "cmd+v" }, ...editor }],
  ["paste menu", { method: "invoke_menu", args: { path: ["Edit", "Paste"] }, ...editor }],
  [
    "click without visible bounds",
    {
      method: "click",
      args: {},
      ...editor,
      elementToken: "s:9",
      element: element("AXButton", "Off", 9),
      placed: { frame: { x: 900, y: 900, w: 20, h: 10 } },
      windowBounds: { x: 0, y: 0, w: 400, h: 300 },
    },
  ],
  [
    "typing after a table name-cell click",
    { method: "type_text", args: { text: "x" }, ...editor, lastClickedTableCell: 3 },
  ],
];

describe("admitDesktopInput strict input guards", () => {
  it.each(GUARDED)("refuses %s in strict mode", (_name, input) => {
    expect(admitDesktopInput({ ...input, strict: true }).refused).toBeDefined();
  });
  it.each(GUARDED)("refuses %s when the setting is absent", (_name, input) => {
    expect(admitDesktopInput(input).refused).toBeDefined();
  });
  it.each(GUARDED)("lets %s through without strict guards", (_name, input) => {
    expect(admitDesktopInput({ ...input, strict: false }).refused).toBeUndefined();
  });
  it("keeps the argument check that is not a guard", () => {
    const refused = admitDesktopInput({
      method: "type_text",
      args: { text: "x", replace: true },
      ...editor,
      strict: false,
    }).refused;
    expect(refused?.code).toBe("unsupported");
  });
});
