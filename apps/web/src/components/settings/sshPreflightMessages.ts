import { msg, useMessages } from "gt-react";

// Preflight reports also carry raw SSH diagnostics. Translate only the known GOAT messages.
const messages = new Set<string>([
  msg("SSH command failed."),
  msg("Invalid SSH identity file."),
  msg("Waits for the connection check."),
  msg("Waits for the host key check."),
  msg("Waits for SSH sign-in."),
  msg("Waits for the platform check."),
  msg("Waits for the disk space check."),
  msg("Waits for the runtime check."),
  msg("Waits for SSH checks."),
  msg("Enable Remote Login (macOS) or start sshd on the host, then check again."),
  msg(
    "Check that Tailscale is running and signed in on both machines, then check the host name and SSH access.",
  ),
  msg("Check the host name, network and SSH port, then check again."),
  msg("The SSH host key changed."),
  msg("Verify the new fingerprint with the host's owner before changing the saved host key."),
  msg("Review and pin this host's SSH fingerprint."),
  msg("Could not collect this host's negotiated SSH fingerprint. Check again."),
  msg("This key is not trusted by known_hosts."),
  msg("This address is already in known_hosts. Approve it once so GOAT can pin it."),
  msg("The SSH host key matches."),
  msg("Set AuthenticationMethods publickey for this user in sshd_config."),
  msg("Enable PubkeyAuthentication yes in sshd_config, then add your public key."),
  msg("Signed in through Tailscale SSH; no key needed."),
  msg("The host let GOAT in without a key."),
  msg("Signed in using an SSH key."),
  msg("SSH needs a POSIX default shell."),
  msg("Windows is missing cygpath."),
  msg("Windows is missing System32 tar."),
  msg(
    "Install Git for Windows and set OpenSSH DefaultShell to its bash; ensure cygpath and Windows System32 tar are available.",
  ),
  msg("Use a supported GOAT host platform."),
  msg("Could not check free space in the home folder."),
]);

export function useSshPreflightMessages() {
  const localize = useMessages();
  return (source: string) => (messages.has(source) ? localize(source) : source);
}
