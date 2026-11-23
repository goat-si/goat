import { useGT } from "gt-react";
import type { TurnFoldStatus } from "./MessagesTimeline.logic";

export function TurnFoldLabel({
  status,
  duration,
}: {
  status: TurnFoldStatus;
  duration: string | null;
}) {
  const gt = useGT();
  switch (status) {
    case "stopped":
      return duration
        ? gt("You stopped after {duration}", { duration })
        : gt("You stopped this response");
    case "continued":
      return duration ? gt("Continued for {duration}", { duration }) : gt("Continued");
    case "worked":
      return duration ? gt("Worked for {duration}", { duration }) : gt("Worked");
  }
}
