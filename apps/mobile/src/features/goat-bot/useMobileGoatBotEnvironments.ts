import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { refusedComputersAtom } from "./keptPerComputerStore";
import { mobileGoatBotEnvironmentInput } from "./mobileGoatBotEnvironments";

export function useMobileGoatBotEnvironments() {
  const { environments } = useEnvironments();
  const refused = useAtomValue(refusedComputersAtom);
  return useMemo(
    () =>
      environments.map((entry) => {
        const input = mobileGoatBotEnvironmentInput(entry);
        return refused.has(entry.environmentId) ? { ...input, refused: true } : input;
      }),
    [environments, refused],
  );
}
