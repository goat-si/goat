package cli

import (
	"errors"
	"fmt"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/daemon"
	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/state"
)

// startConfig applies a start's --relay list (when given) and --name to config.json in one
// change under the state lock, so a relay change the daemon or another command made since is
// kept. afterConfigRead runs once the flags are read and before the change (tests).
func startConfig(st *state.Store, relayURLs []string, name string) (state.Config, error) {
	var list []string
	for _, u := range relayURLs {
		list = append(list, strings.TrimRight(u, "/"))
	}
	if len(list) > 0 {
		if err := daemon.ValidRelays(list); err != nil {
			return state.Config{}, err
		}
	}
	if afterConfigRead != nil {
		afterConfigRead()
	}
	var out state.Config
	var bad error
	err := st.UpdateConfig(func(c *state.Config) {
		next := *c
		if len(list) > 0 {
			next.SetRelays(list)
		}
		if name != "" {
			next.Name = name
		}
		if next.Name == "" {
			next.Name = defaultName()
		}
		switch {
		case len(next.RelayList()) == 0:
			bad = errNoRelay
		case !ident.ValidName(next.Name):
			bad = fmt.Errorf("invalid name %q (1-32 of a-z 0-9 - _ ., starting with a letter or digit)", next.Name)
		default:
			*c = next
		}
		out = *c
	})
	if err != nil {
		return state.Config{}, err
	}
	return out, bad
}

var afterConfigRead func()

var errNoRelay = errors.New("no relay configured; pass --relay https://<relay>")
