package cli

import (
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

func TestResolveAcceptsSshAliasNameNodeIDAndUniquePrefix(t *testing.T) {
	ms := []mesh.Member{
		{Name: "web", NodeID: "abcdefghijklmnopqrstuvwxyz"},
		{Name: "db", NodeID: "abcdzzzzzzzzzzzzzzzzzzzzzz"},
		{Name: "twin", NodeID: "qqqqaaaaaaaaaaaaaaaaaaaaaa"},
		{Name: "twin", NodeID: "qqqqbbbbbbbbbbbbbbbbbbbbbb"},
	}
	for arg, want := range map[string]string{
		"web": "web", "pen-db": "db", "abcdefghijklmnopqrstuvwxyz": "web", "abcde": "web", "pen-qqqqa": "twin",
	} {
		m, err := Resolve(ms, arg)
		if err != nil || m.Name != want {
			t.Fatalf("%s: got %q, %v", arg, m.Name, err)
		}
	}
	for arg, msg := range map[string]string{"abcd": "matches", "twin": "matches", "abc": "at least 4", "nope": "no node"} {
		if _, err := Resolve(ms, arg); err == nil || !strings.Contains(err.Error(), msg) {
			t.Fatalf("%s: got %v, want %q", arg, err, msg)
		}
	}
}

func TestAMemberWhoseNameStartsWithPenResolvesByNameAndAlias(t *testing.T) {
	ms := []mesh.Member{
		{Name: "pen-e2e-a", NodeID: "qms4f24hqqqqqqqqqqqqqqqqqq"},
		{Name: "a", NodeID: "aaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{Name: "pen-a", NodeID: "bbbbbbbbbbbbbbbbbbbbbbbbbb"},
	}
	// ssh-config writes Host pen-<name>, so "pen-a" is the alias of "a" even when "pen-a" exists.
	for arg, want := range map[string]string{
		"pen-e2e-a": "pen-e2e-a", "pen-pen-e2e-a": "pen-e2e-a", "pen-a": "a", "pen-pen-a": "pen-a",
	} {
		m, err := Resolve(ms, arg)
		if err != nil || m.Name != want {
			t.Fatalf("%s: got %q, %v; want %q", arg, m.Name, err, want)
		}
	}
}
