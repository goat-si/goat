// Command pen joins machines into a mesh over a relay and pipes TCP between them.
package main

import (
	_ "embed"
	"fmt"
	"io"
	"os"

	"github.com/goat-si/goat/apps/pen/internal/cli"
)

var version = "dev"

//go:embed install/pen.service
var serviceUnit string

//go:embed install/si.goat.pen.plist
var launchdPlist string

//go:embed install/pen-task.xml
var taskXML string

const usage = `usage: pen <command> [flags]

  up [--relay URL]... [--name N] [--foreground] [--no-service]   start this node (founds a mesh the first time)
  down                                    stop this node
  invite [--ttl 10m] [--auto]             print a single-use join token
  join <token> [--name N]                 join the mesh a token invites to
  identity [--json]                       make this node's keys without joining and print them (pen join keeps them)
  login [--relay URL]... [--name N] [--yes]   sign in with Google: found and bind a mesh, or join the account's mesh
  logout                                  forget this node at the login service (it stays in its mesh)
  lock on|off                             make machines that sign in wait for pen approve
  approve [<id>|'<fingerprint>']          list pending requests, or admit one
  deny <id>|'<fingerprint>'               refuse a pending request for 24 hours
  account [unbind]                        show or remove the mesh's Google account binding
  ls [--json] [--watch [--until-revoked <member>]]   list members
  revoke <member> [--compromised]         remove a member
  leave                                   remove this node and delete its keys
  pipe <node> <port>                      connect stdin/stdout to a member's local port
  pipe --node <id> --noise <key> (<port>|@<service>)   the same on exactly that node, or to its registered service
  service register <name> --port <port>   hold a local service registration (key on stdin) while stdin is open
  forward <localPort> <node>:<port>       forward a local port to a member's port
  ssh-config [--write|--install|--uninstall]   ssh_config for pen-<name> hosts (--install puts it first in ~/.ssh/config)
  dashboard [--no-open] [--stop]          open this node's local management page, or close it
  relay add|rm <url>, relay ls            change or list this node's relays
  relay check <url>                       check a relay end to end (healthz, certificate, a node and a client)
  relay serve [--listen :443] (--autocert <host> --cache <dir> | --cert f --key f | --plain) [--public-origin wss://host]
                                          run a relay
  version                                 print the version
`

type verb func(args []string, stdout, stderr io.Writer) int

func main() {
	cli.Version, cli.ServiceUnit, cli.LaunchdPlist, cli.TaskXML = version, serviceUnit, launchdPlist, taskXML
	verbs := map[string]verb{
		"up": cli.RunUp, "down": cli.RunDown, "invite": cli.RunInvite, "join": cli.RunJoin, "identity": cli.RunIdentity, "ls": cli.RunLs,
		"revoke": cli.RunRevoke, "leave": cli.RunLeave, "pipe": cli.RunPipe, "forward": cli.RunForward,
		"ssh-config": cli.RunSSHConfig, "relay": cli.RunRelay,
		"login": cli.RunLogin, "logout": cli.RunLogout, "lock": cli.RunLock, "approve": cli.RunApprove,
		"deny": cli.RunDeny, "account": cli.RunAccount, "dashboard": cli.RunDashboard, "service": cli.RunService,
	}
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println("pen", version)
		return
	case "help", "--help", "-h":
		fmt.Print(usage)
		return
	}
	run, ok := verbs[os.Args[1]]
	if !ok {
		fmt.Fprintf(os.Stderr, "pen: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	os.Exit(run(os.Args[2:], os.Stdout, os.Stderr))
}
