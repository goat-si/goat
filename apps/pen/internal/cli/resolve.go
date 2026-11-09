package cli

import (
	"fmt"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// Resolve finds one member by name, nodeId or a unique nodeId prefix of at least 4 characters.
// A leading "pen-" (the ssh host alias form) is ignored.
func Resolve(members []mesh.Member, arg string) (mesh.Member, error) {
	q := strings.ToLower(strings.TrimPrefix(arg, "pen-"))
	if q == "" {
		return mesh.Member{}, fmt.Errorf("no node named %q", arg)
	}
	var byName []mesh.Member
	for _, m := range members {
		if m.NodeID == q {
			return m, nil
		}
		if m.Name == q {
			byName = append(byName, m)
		}
	}
	if len(byName) == 1 {
		return byName[0], nil
	}
	if len(byName) > 1 {
		return mesh.Member{}, ambiguous(arg, byName)
	}
	if len(q) < 4 {
		return mesh.Member{}, fmt.Errorf("no node named %q (a nodeId prefix needs at least 4 characters)", arg)
	}
	var byPrefix []mesh.Member
	for _, m := range members {
		if strings.HasPrefix(m.NodeID, q) {
			byPrefix = append(byPrefix, m)
		}
	}
	switch len(byPrefix) {
	case 1:
		return byPrefix[0], nil
	case 0:
		return mesh.Member{}, fmt.Errorf("no node named %q", arg)
	}
	return mesh.Member{}, ambiguous(arg, byPrefix)
}

func ambiguous(arg string, ms []mesh.Member) error {
	var c []string
	for _, m := range ms {
		c = append(c, m.Name+" ("+short(m.NodeID)+")")
	}
	return fmt.Errorf("%q matches %s; use a longer nodeId", arg, strings.Join(c, ", "))
}
