import { createContext, memo, useContext, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";

import { Menu } from "../components/ui/Menu";
import { useMarkdownCodeHighlight } from "../features/threads/markdownCodeHighlightState";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import type { HighlightScheme } from "../lib/highlights";
import { CodeBlockFrame, CodeBlockHeaderButton } from "./CodeBlockFrame";
import { fenceHighlightable, fencedCodeMarkdown } from "./codeBlockMarkdown";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

/**
 * The code of the fence a streaming message leaves open, from its markdown text. A context, so
 * the markdown renderers stay the same functions and the library keeps its rendered blocks.
 */
export const OpenFenceCodeContext = createContext<string | null>(null);

// Header names from enriched-markdown's CodeBlockLanguages.cpp that are not the fence capitalized.
const FENCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  cs: "C#",
  csharp: "C#",
  graphql: "GraphQL",
  objc: "Objective-C",
  objectivec: "Objective-C",
  php: "PHP",
  rb: "Ruby",
  scss: "SCSS",
  sql: "SQL",
  toml: "TOML",
  xml: "XML",
};

// The native block's long-press menu, with its labels and iOS symbols.
const CODE_MENU_ACTIONS = [
  { id: "copy-code", title: "Copy", image: "doc.on.doc" },
  { id: "copy-markdown", title: "Copy as Markdown", image: "doc.text" },
];

type HighlightedCodeBlockProps = {
  readonly code: string;
  readonly fence: string;
  readonly language: string;
  /** False while the library withholds an unclosed fence (`streamingAnimation`, never enabled here). */
  readonly complete: boolean;
  readonly scheme: HighlightScheme;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly codeStyle: NonNullable<MarkdownStyle["codeBlock"]>;
};

/** A fence in a language enriched-markdown cannot colour, drawn like its native block. */
export function HighlightedCodeBlock(props: HighlightedCodeBlockProps) {
  // A fence still streaming, or too large to colour, shows plain until it is finished. The
  // open fence changes on every chunk, so the body is memoized on the answer, not the context.
  const highlightable = fenceHighlightable(props.code, useContext(OpenFenceCodeContext));
  return <HighlightedCodeBlockBody {...props} highlightable={highlightable} />;
}

const HighlightedCodeBlockBody = memo(function HighlightedCodeBlockBody(
  props: HighlightedCodeBlockProps & { readonly highlightable: boolean },
) {
  const { code, codeStyle, textStyle } = props;
  const [wrapped, setWrapped] = useState(false);
  const lines = useMarkdownCodeHighlight({
    code,
    language: props.language,
    theme: props.scheme,
    enabled: props.complete && props.highlightable,
  });
  const fence = props.fence.toLowerCase();
  let offset = 0;
  const text = (
    // Not selectable: as in the native block, a long-press opens the copy menu instead.
    <Text
      style={{
        color: codeStyle.color,
        fontFamily: codeStyle.fontFamily,
        fontSize: codeStyle.fontSize,
        lineHeight: codeStyle.lineHeight,
      }}
    >
      {lines?.flatMap((line, lineIndex) => {
        const separator = lineIndex > 0 ? "\n" : "";
        offset += separator.length;
        return [
          separator,
          ...line.map((token) => {
            const start = offset;
            offset += token.content.length;
            return (
              <Text key={start} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </Text>
            );
          }),
        ];
      }) ?? code}
    </Text>
  );
  // Inside the scroller: on iOS an ancestor JS responder disables a ScrollView's panning.
  const content = (
    <Menu
      shouldOpenOnLongPress
      actions={CODE_MENU_ACTIONS}
      style={{ flexGrow: 1 }}
      onPressAction={({ nativeEvent }) => {
        copyTextWithHaptic(
          nativeEvent.event === "copy-markdown" ? fencedCodeMarkdown(code, props.fence) : code,
        );
      }}
    >
      <Pressable style={{ padding: codeStyle.padding }}>{text}</Pressable>
    </Menu>
  );
  return (
    <CodeBlockFrame
      label={FENCE_DISPLAY_NAMES[fence] ?? fence.charAt(0).toUpperCase() + fence.slice(1)}
      textStyle={textStyle}
      actions={
        <>
          <CodeBlockHeaderButton
            icon="text.alignleft"
            label={wrapped ? "Disable line wrap" : "Wrap lines"}
            textStyle={textStyle}
            active={wrapped}
            onPress={() => setWrapped((value) => !value)}
          />
          <CodeBlockHeaderButton
            icon="doc.on.doc"
            label="Copy code"
            textStyle={textStyle}
            onPress={() => copyTextWithHaptic(code)}
          />
        </>
      }
    >
      {wrapped ? (
        content
      ) : (
        <ScrollView
          horizontal
          // As in the thread feed: with the keyboard open, the first long-press reaches the copy menu.
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ flexGrow: 1 }}
        >
          {content}
        </ScrollView>
      )}
    </CodeBlockFrame>
  );
});
