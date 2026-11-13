import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  createNativeMemoryHarness,
  renderNative,
  type NativeMemoryHarness,
} from "../../testing/memoryNativeHarness";

const appearance = vi.hoisted(() => ({ mode: "light" as "light" | "dark", baseFontSize: 16 }));

// Editing a member from its chat reads secure storage and bot permissions; these tests do not.
vi.mock("./MobileNewBotNameRow", () => ({
  useMobileBotEditing: () => ({ nameRow: null, editSheet: null, openEdit: undefined }),
}));
vi.mock("@legendapp/list/react-native", () => ({ LegendList: () => null }));
vi.mock("./MobileBotWork", () => ({ MobileBotWork: () => null }));
// Chat file cards read the Library through the environment runtime; GoatBotTimelineRow.files.test covers them.
vi.mock("./GoatBotReplyFiles", () => ({
  GoatBotFilesProvider: (props: { children?: unknown }) => props.children,
  GoatBotReplyFiles: () => null,
  chatFilesScope: () => "chat",
}));
vi.mock("./openBotLibraryFile", () => ({ openBotLibraryFile: async () => null }));
vi.mock("./useGoatBotEventTargets", () => ({
  useGoatBotEventTargets: () => ({ land: () => null, key: "" }),
}));
vi.mock("./GoatBotFace", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotHeaderFace: () => null,
    GoatBotProgressFace: (props: { state: string; inView: boolean }) => (
      <Text>{`face:${props.state}:${props.inView}|`}</Text>
    ),
  };
});
vi.mock("./GoatBotShimmerText", async () => {
  const { Text } = await import("react-native");
  return {
    GoatBotShimmerText: (props: { label: string; animate: boolean }) => (
      <Text>{`shimmer:${props.label}:${props.animate}`}</Text>
    ),
  };
});
// The real GoatBotMarkdown runs; only the native renderer under it is replaced by its source text,
// with each link's pill label and the long press it was given.
const native = vi.hoisted(() => ({
  longPress: null as null | ((url: string) => void),
  markdown: [] as string[],
}));
vi.mock("../../native/SelectableMarkdownText", async () => {
  const { Text } = await import("react-native");
  return {
    SelectableMarkdownText: (props: {
      markdown: string;
      linkCustomization?: (url: string) => { label?: string } | undefined;
      onLinkLongPress?: (url: string) => void;
    }) => {
      native.longPress = props.onLinkLongPress ?? null;
      native.markdown.push(props.markdown);
      const urls = [...new Set(props.markdown.match(/https?:\/\/[^\s<>)\]|]+/g) ?? [])];
      const pills = urls.flatMap((url) => {
        const label = props.linkCustomization?.(url)?.label;
        return label === undefined ? [] : [`pill[${url}=${label}]`];
      });
      return <Text>{`md[${props.markdown}]${pills.join("")}`}</Text>;
    },
  };
});
vi.mock("./GoatBotComposerAttachments", () => ({
  GoatBotAttachButton: () => null,
  GoatBotAttachmentStrip: () => null,
  releaseGoatBotAttachments: () => {},
}));
vi.mock("@react-navigation/elements", async () => ({
  HeaderHeightContext: (await import("react")).createContext<number | undefined>(undefined),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: (props: { children?: unknown }) => props.children },
  useAnimatedStyle: (style: () => object) => style(),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: () => null,
  useReanimatedKeyboardAnimation: () => ({ progress: { value: 0 } }),
}));
vi.mock("../../native/NativeScrollViewMarker", () => ({ NativeScrollView: () => null }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("./useMobileGoatBotHomeSettings", () => ({
  useMobileGoatBotHomeSettings: () => ({ moveTarget: null, error: null }),
}));
vi.mock("./useMobileGoatBotSession", () => ({ useMobileGoatBotSession: () => ({}) }));
vi.mock("../../components/GoatWordmark", () => ({ GoatWordmark: () => null }));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./useMobileGoatBotModel", () => ({ useMobileGoatBotModelMenu: () => null }));
vi.mock("./useMobileGoatBotMemberModel", () => ({ useMobileGoatBotMemberModelMenu: () => null }));
vi.mock("./GoatBotModelPill", () => ({ GoatBotModelPill: () => null }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: clipboard.copy }));

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: appearance.mode,
    appearance: { baseFontSize: appearance.baseFontSize },
  }),
}));
// Opening a thread link reads the shell list; this test only reads what the reply shows.
vi.mock("../../state/threads", () => ({ environmentThreadShells: () => null }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => [] } }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
import { Alert } from "react-native";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { GoatBotTimelineRow } from "./GoatBotScreen";

let h: NativeMemoryHarness;
let view: ReturnType<typeof renderNative>;
afterEach(async () => {
  await view?.unmount();
  h?.dispose();
});

const props = { canSend: true, onSend: () => true, onRetry: vi.fn(), onSelectThread: () => {} };
const pr = (n: number, repo: string) => `https://github.com/${repo}/pull/${n}`;

it("reads pull request links against the whole reply, across its prose and table cards", async () => {
  const text = [
    `**Fixed** in ${pr(7, "a/repo")}; #8 is next.`,
    "",
    "| PR |",
    "| - |",
    `| ${pr(9, "b/repo")} |`,
  ].join("\n");
  h = createNativeMemoryHarness();
  view = renderNative(
    h,
    <GoatBotTimelineRow
      {...props}
      row={{
        kind: "bot",
        id: "bot",
        text,
        createdAt: "2026-10-12T09:40:00Z",
        tone: "reply",
        proactive: false,
        replyTo: null,
        options: [],
        firstInGroup: true,
        groupPosition: "single",
      }}
    />,
  );
  await view.render();
  const shown = view.container.textContent ?? "";
  // Two repositories in one reply: each link keeps its repository, and a bare #8 links nowhere.
  // The address stays the link's words, so a screen reader hears it after the short label.
  expect(shown).toContain(`**Fixed** in <${pr(7, "a/repo")}>; #8 is next.`);
  expect(shown).toContain(`pill[${pr(7, "a/repo")}=a/repo#7]`);
  expect(shown).toContain(`| <${pr(9, "b/repo")}> |`);
  expect(shown).toContain(`pill[${pr(9, "b/repo")}=b/repo#9]`);
  expect(shown).not.toContain("[#8]");
});

const reply = (text: string) => ({
  kind: "bot" as const,
  id: "bot",
  text,
  createdAt: "2026-10-12T09:40:00Z",
  tone: "reply" as const,
  proactive: false,
  replyTo: null,
  options: [],
  firstInGroup: true,
  groupPosition: "single" as const,
});
/** Each test starts with no renderer handler or Markdown left from an earlier one. */
function setup() {
  native.longPress = null;
  native.markdown.length = 0;
  clipboard.copy.mockClear();
}
async function show(row: Parameters<typeof GoatBotTimelineRow>[0]["row"]) {
  setup();
  h = createNativeMemoryHarness();
  view = renderNative(h, <GoatBotTimelineRow {...props} row={row} />);
  await view.render();
  return view.container.textContent ?? "";
}

it("leaves an address inside inline HTML as written, with no short label", async () => {
  const shown = await show(reply(`Merged <span>${pr(7, "a/repo")}</span> today.`));
  expect(shown).toContain(`md[Merged <span>${pr(7, "a/repo")}</span> today.]`);
  expect(shown).not.toContain("pill[");
});

type LinkNode = { type: string; url?: string; children?: LinkNode[] };
const parser = unified().use(remarkParse).use(remarkGfm);
/** The link addresses Markdown holds, in order, as the renderer's parser reads them. */
function destinations(markdown: string): string[] {
  const found: string[] = [];
  const walk = (node: LinkNode) => {
    if (node.type === "link" && node.url !== undefined) found.push(node.url);
    for (const child of node.children ?? []) walk(child);
  };
  walk(parser.parse(markdown) as LinkNode);
  return found;
}

it("keeps every link's address when it relabels one, and a long press copies that address", async () => {
  const base = pr(7, "a/repo");
  const written = [
    `${base}?q=&amp;`,
    `${base}?q=&amp;amp;`,
    `${base}?q=)`,
    `${base}?q=a%20b`,
    `${base}?q=a\\b`,
  ];
  const alert = vi.spyOn(Alert, "alert");
  for (const address of written) {
    const url = destinations(`<${address}>`)[0] ?? "";
    // The bot's own words linking to the same address, written so Markdown reads it back exactly.
    const named = `[the fix](<${url.replace(/[<>\\]/g, "\\$&").replaceAll("&", "&amp;")}>)`;
    expect(destinations(named)).toEqual([url]);
    // Bare only, then bare beside the bot's own words, where the short link is written in.
    for (const text of [`**See** <${address}>.`, `**See** <${address}> and ${named}.`]) {
      await show(reply(text));
      const sent = native.markdown.at(-1) ?? "";
      expect(destinations(sent)).toEqual(destinations(text));
      alert.mockClear();
      native.longPress?.(url);
      const [title, , buttons] = alert.mock.calls[0] ?? [];
      expect(title).toBe(url);
      expect(buttons?.map((button) => button.text)).toEqual(["Cancel", "Copy link", "Open link"]);
      buttons?.find((button) => button.text === "Copy link")?.onPress?.();
      expect(clipboard.copy).toHaveBeenLastCalledWith(url, { target: "link" });
      await view.unmount();
      h.dispose();
    }
  }
  alert.mockRestore();
  await show(reply("x"));
});

it("keeps a collapsed task summary's indented code as written", async () => {
  const summary = [
    "Reproduce it with:",
    "",
    `    curl ${pr(7, "a/repo")}`,
    "",
    "Then read the log.",
    "It should pass now.",
    "Done.",
  ].join("\n");
  const shown = await show({
    kind: "task",
    id: "card",
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: true,
    groupPosition: "single",
    card: {
      key: "task-1",
      revision: 1,
      updatedAt: "2026-10-12T09:41:00Z",
      title: "Fix the flaky test",
      statusLabel: "Done",
      tone: "success",
      sourceLabel: null,
      summary,
      attentionLabel: null,
      pullRequests: [],
      target: { kind: "none", label: "Unavailable" },
    },
  });
  expect(shown).toContain(`curl ${pr(7, "a/repo")}`);
  expect(shown).not.toContain("a/repo#7");
});

it("leaves a link whose address holds a control character, tab or line break exactly as written", async () => {
  const odd = pr(7, "b/repo");
  const links = [
    `[${odd}?q=a&#10;b](<${odd}?q=a&#10;b>)`,
    `[${odd}?q=a\u0001b](<${odd}?q=a\u0001b>)`,
    `[${odd}?q=a\tb](<${odd}?q=a\tb>)`,
  ];
  for (const link of links) {
    await show(reply(`**Fixed** in ${pr(9, "a/repo")}; see ${link}.`));
    const sent = native.markdown.at(-1) ?? "";
    expect(sent).toContain(`see ${link}.`);
    // The odd address takes no part in choosing the reply's repository: #9 still shortens alone.
    expect(view.container.textContent).toContain(`pill[${pr(9, "a/repo")}=#9]`);
    await view.unmount();
    h.dispose();
  }
  await show(reply("x"));
});

it("bounds an unclosed inline tag to its paragraph in a collapsed task summary", async () => {
  const summary = [
    "<span>Note",
    "",
    `Fixed in ${pr(7, "a/repo")}.`,
    "Then read the log.",
    "It should pass now.",
    "Done.",
    "Really.",
  ].join("\n");
  const shown = await show({
    kind: "task",
    id: "card",
    createdAt: "2026-10-12T09:41:00Z",
    firstInGroup: true,
    groupPosition: "single",
    card: {
      key: "task-1",
      revision: 1,
      updatedAt: "2026-10-12T09:41:00Z",
      title: "Fix the flaky test",
      statusLabel: "Done",
      tone: "success",
      sourceLabel: null,
      summary,
      attentionLabel: null,
      pullRequests: [],
      target: { kind: "none", label: "Unavailable" },
    },
  });
  expect(shown).toContain("Fixed in #7.");
  expect(shown).not.toContain(pr(7, "a/repo"));
});

type ReferenceNode = LinkNode & { identifier?: string; title?: string | null };
/** Where each link and reference leads, in order, resolving references against their definitions. */
function resolvedLinks(markdown: string): string[] {
  const tree = parser.parse(markdown) as ReferenceNode;
  const defined = new Map<string, string>();
  const found: string[] = [];
  const collect = (node: ReferenceNode) => {
    if (
      node.type === "definition" &&
      node.identifier !== undefined &&
      !defined.has(node.identifier)
    )
      defined.set(node.identifier, (node.url ?? "") + " " + (node.title ?? ""));
    for (const child of node.children ?? []) collect(child);
  };
  const walk = (node: ReferenceNode) => {
    if (node.type === "link") found.push((node.url ?? "") + " " + (node.title ?? ""));
    if (node.type === "linkReference")
      found.push(defined.get(node.identifier ?? "") ?? "unresolved");
    if (node.type !== "definition") for (const child of node.children ?? []) walk(child);
  };
  collect(tree);
  walk(tree);
  return found;
}

it("draws the tables of a reply with link references in their own cards, every reference still leading where it did", async () => {
  const text = [
    "See [the notes][x] and [the plan].",
    "",
    "| Step | Link |",
    "| --- | --- |",
    "| Read | [the notes][X] |",
    "",
    '[x]: <https://example.com/notes page> "The notes"',
    "[The  Plan]: https://example.com/plan",
  ].join("\n");
  await show(reply(text));
  expect(view.container.querySelector('[aria-label="Copy table"]')).not.toBeNull();
  // The words and the table, each in its own card; the definitions alone draw no card.
  expect(native.markdown).toHaveLength(2);
  expect(native.markdown.flatMap((markdown) => resolvedLinks(markdown))).toEqual(
    resolvedLinks(text),
  );
  expect(resolvedLinks(text)).not.toContain("unresolved");
});

vi.mock("./GoatBotHeroFace", () => ({ GoatBotHeroFace: () => null }));
