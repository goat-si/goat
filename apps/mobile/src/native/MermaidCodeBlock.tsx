import * as Hash from "effect/Hash";
import { File, Paths } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { Suspense, use, useRef, useState } from "react";
import { PixelRatio, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { parse, Svg, SvgXml } from "react-native-svg";

import { MediaImagePreview } from "../components/MediaImagePreview";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { withDiagramBackground } from "../lib/mermaidSvg";
import { type Diagram, loadDiagram, themedDiagramSvg } from "./mermaidDiagrams";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { CodeBlockFrame, CodeBlockHeaderButton } from "./CodeBlockFrame";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

const MONOSPACE = Platform.OS === "ios" ? "Menlo" : "monospace";
// Pele measures labels with metrics close to Helvetica when no canvas is available.
const DIAGRAM_FONT = Platform.OS === "ios" ? "Helvetica" : "sans-serif";

// The image viewer zooms a bitmap: about twice a phone's screen leaves room to zoom while
// bounding the memory one image takes.
const EXPORT_LONGEST_SIDE = 3072;

/** Named by content, so a theme change never shows a stale image cached under the same URI. */
async function writeDiagramImage(xml: string, base64: string): Promise<string> {
  const file = new File(
    Paths.cache,
    "goat-diagrams",
    `${(Hash.string(xml) >>> 0).toString(36)}.png`,
  );
  file.create({ intermediates: true, overwrite: true });
  await file.write(base64, { encoding: "base64" });
  return file.uri;
}

type Expansion =
  | { readonly status: "exporting" }
  | { readonly status: "open"; readonly uri: string };

type MermaidCodeBlockProps = {
  readonly code: string;
  readonly textStyle: NativeMarkdownTextStyle;
};

/** A complete ```mermaid fence, drawn as its diagram with a toggle back to the source. */
export function MermaidCodeBlock(props: MermaidCodeBlockProps) {
  return (
    <Suspense fallback={<MermaidBlock {...props} diagram={null} />}>
      <RenderedMermaidBlock {...props} />
    </Suspense>
  );
}

function RenderedMermaidBlock(props: MermaidCodeBlockProps) {
  return <MermaidBlock {...props} diagram={use(loadDiagram(props.code.trim()))} />;
}

function MermaidBlock(props: MermaidCodeBlockProps & { readonly diagram: Diagram | null }) {
  const { code, textStyle, diagram } = props;
  const [showCode, setShowCode] = useState(false);
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  const exportSvg = useRef<Svg>(null);
  const secondaryColor = themeColorWithAlpha(textStyle.codeColor, 0.6);
  const codeFontSize = textStyle.fontSize * 0.9;
  const svg =
    diagram?.status === "ready"
      ? themedDiagramSvg(diagram, {
          "--pele-bg": textStyle.codeBlockBackgroundColor,
          "--pele-fg": textStyle.color,
          "--pele-muted": themeColorWithAlpha(textStyle.color, 0.65),
          "--pele-line": themeColorWithAlpha(textStyle.color, 0.55),
          "--pele-surface": themeColorWithAlpha(textStyle.color, 0.06),
          "--pele-surface-alt": themeColorWithAlpha(textStyle.color, 0.12),
          "--pele-border": themeColorWithAlpha(textStyle.color, 0.28),
          "--pele-accent": textStyle.linkColor,
          "--pele-font": DIAGRAM_FONT,
          "--pele-font-mono": MONOSPACE,
        })
      : null;
  const exportXml =
    expansion?.status === "exporting" && svg
      ? withDiagramBackground(svg, textStyle.codeBlockBackgroundColor)
      : null;
  const exportTree = exportXml ? parse(exportXml) : null;
  const exportScale =
    diagram?.status === "ready" ? EXPORT_LONGEST_SIDE / Math.max(diagram.width, diagram.height) : 0;
  // In points. iOS draws the copy at its own size and the screen scale, Android at the
  // requested pixels, so the copy is laid out at the export size for both.
  const exportSize =
    diagram?.status === "ready"
      ? {
          width: (diagram.width * exportScale) / PixelRatio.get(),
          height: (diagram.height * exportScale) / PixelRatio.get(),
        }
      : null;

  // Runs once the hidden export copy has laid out.
  const exportDiagram = () => {
    if (!exportSvg.current || !exportXml || !exportSize) return;
    const pixels = Platform.OS === "ios" ? 1 : PixelRatio.get();
    exportSvg.current.toDataURL(
      (base64) => {
        // A failed capture calls back with nothing; let the next tap try again.
        if (!base64) {
          setExpansion(null);
          return;
        }
        // iOS wraps the encoding in line feeds.
        writeDiagramImage(exportXml, base64.replace(/\s/g, "")).then(
          (uri) => setExpansion({ status: "open", uri }),
          () => setExpansion(null),
        );
      },
      {
        width: Math.round(exportSize.width * pixels),
        height: Math.round(exportSize.height * pixels),
      },
    );
  };

  return (
    <CodeBlockFrame
      label="Mermaid"
      textStyle={textStyle}
      actions={
        <>
          {svg ? (
            <CodeBlockHeaderButton
              icon={showCode ? "flowchart" : "chevron.left.forwardslash.chevron.right"}
              label={showCode ? "Show diagram" : "Show code"}
              textStyle={textStyle}
              onPress={() => setShowCode((value) => !value)}
            />
          ) : null}
          <CodeBlockHeaderButton
            icon="doc.on.doc"
            label="Copy code"
            textStyle={textStyle}
            onPress={() => copyTextWithHaptic(code)}
          />
        </>
      }
    >
      <View style={styles.content}>
        {diagram?.status === "error" ? (
          <Text style={[styles.error, { color: secondaryColor, fontSize: codeFontSize * 0.85 }]}>
            Unable to render diagram: {diagram.message}
          </Text>
        ) : null}
        {svg && diagram?.status === "ready" && !showCode ? (
          // In a row the width resolves first, so the height follows the shrunk width;
          // a column with maxWidth would size the height from the full width.
          <View style={styles.diagramRow}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel="Mermaid diagram"
              accessibilityHint="Opens the diagram full screen"
              onPress={() => {
                if (expansion) return;
                void Haptics.selectionAsync();
                setExpansion({ status: "exporting" });
              }}
              style={{
                flexBasis: diagram.width,
                flexShrink: 1,
                aspectRatio: diagram.width / diagram.height,
              }}
            >
              <SvgXml xml={svg} width="100%" height="100%" />
            </Pressable>
          </View>
        ) : (
          <Text
            selectable
            style={{
              color: textStyle.codeColor,
              fontFamily: MONOSPACE,
              fontSize: codeFontSize,
              lineHeight: codeFontSize * 1.45,
            }}
          >
            {code}
          </Text>
        )}
      </View>
      {expansion?.status === "exporting" && exportTree && exportSize ? (
        <View pointerEvents="none" style={[styles.exportCopy, exportSize]} onLayout={exportDiagram}>
          <Svg ref={exportSvg} {...exportTree.props} width="100%" height="100%">
            {exportTree.children}
          </Svg>
        </View>
      ) : null}
      {expansion?.status === "open" ? (
        <MediaImagePreview
          source={{
            kind: "image",
            uri: expansion.uri,
            name: "Mermaid diagram",
            mimeType: "image/png",
            actionsSource: {
              uri: expansion.uri,
              name: "Mermaid diagram.png",
              mimeType: "image/png",
            },
          }}
          onRequestClose={() => setExpansion(null)}
        />
      ) : null}
    </CodeBlockFrame>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12 },
  diagramRow: { flexDirection: "row", justifyContent: "center" },
  error: { marginBottom: 8 },
  exportCopy: { position: "absolute", opacity: 0 },
});
