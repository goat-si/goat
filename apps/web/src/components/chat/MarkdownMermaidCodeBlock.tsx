import { CodeIcon, WorkflowIcon } from "~/components/solar";
import { Suspense, use, useRef, useState, type ReactNode } from "react";

import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { findRevealRef, MarkdownFindContext } from "./markdownFindContext";
import { MermaidDiagram } from "./MermaidDiagram";

export function MarkdownMermaidCodeBlock({
  code,
  fenceTitle,
  theme,
  isStreaming,
  onExpand,
  children,
}: {
  code: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  isStreaming: boolean;
  onExpand: (imageUrl: string) => void;
  children: ReactNode;
}) {
  const [showCode, setShowCode] = useState(false);
  // Switching views remounts the toolbar, so the toggle hands focus to its replacement.
  const refocusToggle = useRef(false);
  const focusReplacementToggle = (button: HTMLButtonElement | null) => {
    if (!button || !refocusToggle.current) return;
    refocusToggle.current = false;
    button.focus();
  };
  const searching = use(MarkdownFindContext);
  const revealSource = () => setShowCode(true);
  const sourceRevealRef = findRevealRef(revealSource);
  const showDiagram = !showCode && !isStreaming && code.trim().length > 0;
  const toggleLabel = showCode ? "Show diagram" : "Show code";
  return (
    <MarkdownCodeBlock
      code={code}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      isStreaming={isStreaming}
      canWrap={!showDiagram}
      diagram={showDiagram}
      viewToggle={
        isStreaming ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  ref={focusReplacementToggle}
                  type="button"
                  variant="ghost-muted"
                  size="icon-xs"
                  onClick={() => {
                    refocusToggle.current = true;
                    setShowCode((value) => !value);
                  }}
                  aria-label={toggleLabel}
                />
              }
            >
              {showCode ? <WorkflowIcon className="size-3" /> : <CodeIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{toggleLabel}</TooltipPopup>
          </Tooltip>
        )
      }
    >
      {showDiagram ? (
        <RenderErrorBoundary resetKeys={[code, theme]} fallback={children}>
          <Suspense
            fallback={
              <pre className="invisible" aria-hidden>
                {code}
              </pre>
            }
          >
            <MermaidDiagram source={code} onExpand={onExpand} />
          </Suspense>
          {searching ? (
            <pre ref={sourceRevealRef} hidden aria-hidden>
              {code}
            </pre>
          ) : null}
        </RenderErrorBoundary>
      ) : (
        children
      )}
    </MarkdownCodeBlock>
  );
}
