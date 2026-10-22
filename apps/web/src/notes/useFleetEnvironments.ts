import { connectionRoutes } from "@goat/client-runtime/connection";
import * as Option from "effect/Option";
import { useEnvironments } from "../state/environments";

export function useFleetEnvironments() {
  const { environments } = useEnvironments();
  return environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    sshAliases: connectionRoutes(environment.entry).flatMap((route) => {
      const profile = Option.getOrNull(route.profile);
      return profile?._tag === "SshConnectionProfile" ? [profile.target.alias] : [];
    }),
  }));
}
