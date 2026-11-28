// A bot's settings, Model row (board 1QYE-2): the bot's name and job, then the same model picker as the composer.
// The choice is sent with change_thread on the bot's thread and applies from its next turn.
import type { ReactNode } from "react";
import { ModelChip, type Selection } from "./ModelChip.tsx";
import { FAINT, INK, MUTED, Row, Section, text } from "./ui.tsx";

export function BotSettingsMain({ name, purpose, selection, onChange, error }: {
  name: string; purpose: string | null; selection: Selection; onChange: ((s: Selection) => void) | null; error: string | null;
}): ReactNode {
  return (
    <div data-bot-settings="" style={{ backgroundColor: "#FFFFFF", display: "flex", flex: "1 1 0%", justifyContent: "center", minWidth: 0, overflow: "auto" }}>
      <div style={{ display: "flex", flexDirection: "column", maxWidth: 680, paddingBlock: 28, paddingInline: 32, width: "100%", boxSizing: "border-box" }}>
        <h1 style={{ margin: 0, ...text(20, INK, 600) }}>{name}</h1>
        {purpose ? <div style={{ ...text(13, MUTED), marginTop: 4 }}>{purpose}</div> : null}
        <div style={{ marginTop: 12 }}>
          <Section title="Model">
            <Row label="Runs on">
              <ModelChip variant="field" selection={selection} onChange={onChange} label={name} error={error} />
            </Row>
            <div style={text(12, FAINT)}>{onChange ? "New messages to this bot use this model. Running work keeps its model." : `Send ${name} a first message, then pick its model here.`}</div>
          </Section>
        </div>
      </div>
    </div>
  );
}

