package daemon

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// What the CLI and the dashboard both say or check, so the two cannot drift apart.

// DefaultDownloadRelay serves install.sh and the release binaries when config.json names no
// downloadRelay.
const DefaultDownloadRelay = "https://pen-relay.pos090001.workers.dev"

// ApproveQuestion is asked before a request named by its short id is approved.
const ApproveQuestion = "Approve this machine? It gets full access to every machine in the mesh."

// InstallCommand installs pen on a new machine and joins the mesh token invites to.
func InstallCommand(downloadRelay, token string) string {
	return "curl -fsSL " + shellWord(downloadRelay+"/install.sh") + " | sh -s -- --join " + shellWord(token)
}

// LoginCommand installs pen on a new machine and signs it in with Google.
func LoginCommand(downloadRelay string) string {
	return "curl -fsSL " + shellWord(downloadRelay+"/install.sh") + " | sh -s -- --login"
}

// shellWord leaves a plain URL or token as it is and single-quotes anything else (config.json can be
// edited by hand), so a copied command never runs text from the value.
func shellWord(s string) string {
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune(":/._-", c)) {
			return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'"
		}
	}
	return s
}

// CompromisedNextSteps is what to do after revoking a stolen member of a mesh bound to acct
// ("" when the mesh has no account binding).
func CompromisedNextSteps(name string, acct *mesh.Account) string {
	if acct == nil {
		return ""
	}
	return fmt.Sprintf("%s may still hold a Google sign-in for this mesh's account. Run pen lock on so new machines need approval, "+
		"change the Google password, and reset the account's machine list at %s/device after signing in.", name, acct.LoginURL)
}

// ValidRelays checks a node's relay list by the invite token rules, since invites carry it.
func ValidRelays(relays []string) error {
	return mesh.ValidRelayList(relays)
}

// CleanRelays trims spaces and trailing slashes as pen relay add does.
func CleanRelays(relays []string) []string {
	out := make([]string, 0, len(relays))
	for _, u := range relays {
		out = append(out, strings.TrimRight(strings.TrimSpace(u), "/"))
	}
	return out
}

// NormalizeFingerprint drops spaces and upper-cases a fingerprint or request id.
func NormalizeFingerprint(s string) string {
	return strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(s), " ", ""))
}

// MatchPending finds the request a full fingerprint names, or the one request an 8-character id
// names.
func MatchPending(ps []Pending, arg string) (Pending, error) {
	want := NormalizeFingerprint(arg)
	var hits []Pending
	for _, p := range ps {
		fp := NormalizeFingerprint(p.Fingerprint)
		if len(want) == len(fp) && want == fp || len(want) == 8 && strings.HasPrefix(fp, want) {
			hits = append(hits, p)
		}
	}
	switch {
	case len(hits) == 1:
		return hits[0], nil
	case len(hits) > 1:
		return Pending{}, fmt.Errorf("%d pending requests match %q; give the full fingerprint", len(hits), arg)
	case len(want) != 8 && len(want) != 40:
		return Pending{}, errors.New("give the request id (8 characters) or the full fingerprint (40)")
	}
	return Pending{}, fmt.Errorf("no pending request matches %q", arg)
}

// DownloadRelayOf is where invitees fetch install.sh: the configured download relay, else the
// release Worker (a self-hosted pen relay serve does not serve install.sh).
func DownloadRelayOf(cfg state.Config) string {
	if cfg.DownloadRelay != "" {
		return cfg.DownloadRelay
	}
	return DefaultDownloadRelay
}

// downloadRelay reads config.json, where pen relay download may have changed it since start.
func (d *Daemon) downloadRelay() string {
	cfg, err := d.st.LoadConfig()
	if err != nil {
		d.cfgMu.Lock()
		cfg = d.cfg
		d.cfgMu.Unlock()
	}
	return DownloadRelayOf(cfg)
}

// setRelays saves a new relay list and reconnects the uplinks (op "relays").
func (d *Daemon) setRelays(list []string) (Status, error) {
	list = CleanRelays(list)
	if err := ValidRelays(list); err != nil {
		return Status{}, err
	}
	d.cfgMu.Lock()
	changed := !slices.Equal(d.cfg.RelayList(), list)
	d.cfg.SetRelays(list)
	d.cfgMu.Unlock()
	if changed {
		if err := d.saveConfig(); err != nil {
			return Status{}, err
		}
		d.startUplinks()
	}
	return d.status(), nil
}

// ConfigError is a config.json the daemon cannot start with. Starting again cannot fix it, so a
// service must not be restarted for it.
type ConfigError struct{ Reason string }

func (e *ConfigError) Error() string { return e.Reason }

// CheckConfig is the daemon's start check of config.json.
func CheckConfig(cfg state.Config) error {
	if cfg.Relay == "" {
		return &ConfigError{"no relay configured; run pen up --relay URL"}
	}
	if err := ValidRelays(cfg.RelayList()); err != nil {
		return &ConfigError{fmt.Sprintf("the relays in config.json cannot be used (%v); replace them with pen up --relay <https URL> (repeat --relay for more; pen relay ls lists them)", err)}
	}
	return nil
}
