import { useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { GoatBotCard } from "./GoatBotMessageParts";
import { GoatBotTableCard } from "./GoatBotTableCard";
import { goatBotReplyPartKeys, splitGoatBotReply } from "./goatBotReplyParts";

/**
 * A bot reply as cards: its words, then each table in a card of its own, then the words after it.
 * A reply without a table stays one card.
 */
export function GoatBotReplyCards(props: {
  /** The reply as the bot wrote it. */
  readonly text: string;
  /** Draws one stretch of the reply the way the chat draws bot words. */
  readonly renderText: (text: string) => ReactNode;
  /** Shown under the reply's last words, such as a memory link. */
  readonly footer?: ReactNode;
}) {
  const parts = useMemo(() => splitGoatBotReply(props.text), [props.text]);
  const keys = useMemo(() => goatBotReplyPartKeys(props.text, parts), [parts, props.text]);
  if (parts.length === 1 && parts[0]?.kind === "prose") {
    return (
      <GoatBotCard>
        {props.renderText(props.text)}
        {props.footer}
      </GoatBotCard>
    );
  }
  return (
    <View className="gap-1">
      {parts.map((part, index) => {
        const last = index === parts.length - 1;
        return part.kind === "table" ? (
          <GoatBotTableCard key={keys[index]} columns={part.columns} markdown={part.markdown}>
            {props.renderText(part.markdown)}
          </GoatBotTableCard>
        ) : (
          <GoatBotCard key={keys[index]}>
            {props.renderText(part.text)}
            {last ? props.footer : null}
          </GoatBotCard>
        );
      })}
      {parts.at(-1)?.kind === "table" && props.footer ? (
        <GoatBotCard>{props.footer}</GoatBotCard>
      ) : null}
    </View>
  );
}
