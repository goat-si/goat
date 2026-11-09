package ident

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestVectorsMatchNodeIDAndFingerprint(t *testing.T) {
	raw, err := os.ReadFile("../../../../packages/pen-protocol/vectors/identity.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		SignSeed, SignPub, NodeID, NoisePriv, NoisePub, Fingerprint string
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	seed, _ := hex.DecodeString(v.SignSeed)
	np, _ := hex.DecodeString(v.NoisePriv)
	id, err := FromSeeds(seed, np)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(id.SignPub) != v.SignPub || hex.EncodeToString(id.NoisePub) != v.NoisePub {
		t.Fatal("derived public keys differ")
	}
	if id.NodeID() != v.NodeID || !ValidNodeID(id.NodeID()) {
		t.Fatalf("nodeId %s, want %s", id.NodeID(), v.NodeID)
	}
	if got := Fingerprint(id.NoisePub); got != v.Fingerprint {
		t.Fatalf("fingerprint %s, want %s", got, v.Fingerprint)
	}
}

func TestNodeNamesFollowTheContractRule(t *testing.T) {
	for name, ok := range map[string]bool{
		"a": true, "web-1.prod_x": true, "9lives": true, "": false, "-a": false, ".a": false, "A": false,
		"has space": false, "abcdefghijklmnopqrstuvwxyz012345": true, "abcdefghijklmnopqrstuvwxyz0123456": false,
	} {
		if ValidName(name) != ok {
			t.Fatalf("ValidName(%q) = %v", name, !ok)
		}
	}
}

