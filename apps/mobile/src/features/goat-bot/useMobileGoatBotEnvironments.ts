import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { mobileGoatBotEnvironmentInput } from "./mobileGoatBotEnvironments";

export function useMobileGoatBotEnvironments() {
  const { environments } = useEnvironments();
  return useMemo(() => environments.map(mobileGoatBotEnvironmentInput), [environments]);
}
