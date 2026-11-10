package daemon

import (
	"encoding/json"
	"errors"

	"github.com/goat-si/goat/apps/pen/internal/state"
)

// VersionsFile keeps the pen version each member (by Noise key) last announced in a sync hello.
//
// Account and lock records wait until every member runs 1.1 (contract "Mesh records"). A member
// reachable now answers for itself; an offline one counts with its last announcement, so one
// machine being off does not disable lock mode or rebinding. A member that downgrades to 1.0 while
// offline is not detected until it syncs again: downgrades are unsupported.
const VersionsFile = "versions.json"

// loadVersions reads the stored announcements. A file that does not parse reads as empty: that
// fails closed (no member counts as 1.1 until it announces again) instead of stopping the daemon.
func loadVersions(st *state.Store) (map[string]string, error) {
	v := map[string]string{}
	if _, err := st.ReadJSON(VersionsFile, &v); err != nil {
		var syntax *json.SyntaxError
		var typ *json.UnmarshalTypeError
		if errors.As(err, &syntax) || errors.As(err, &typ) {
			return map[string]string{}, nil
		}
		return nil, err
	}
	return v, nil
}

func (d *Daemon) saveVersions(v map[string]string) error {
	unlock, err := d.st.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return d.st.WriteJSON(VersionsFile, v, 0o600)
}
