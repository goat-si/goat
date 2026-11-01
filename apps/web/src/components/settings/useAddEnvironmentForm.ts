import { useState } from "react";

export function useAddEnvironmentForm() {
  const mode = useState<"remote" | "ssh">("remote");
  const host = useState("");
  const pairingCode = useState("");
  const sshHost = useState("");
  const sshUsername = useState("");
  const sshPort = useState("");
  const suggestionsOpen = useState(false);
  const reset = () => {
    mode[1]("remote");
    host[1]("");
    pairingCode[1]("");
    sshHost[1]("");
    sshUsername[1]("");
    sshPort[1]("");
    suggestionsOpen[1](false);
  };
  return { mode, host, pairingCode, sshHost, sshUsername, sshPort, suggestionsOpen, reset };
}
