package daemon

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
	"github.com/goat-si/goat/apps/pen/internal/session"
)

var updateServiceVectors = flag.Bool("update-service", false, "rewrite packages/pen-protocol/vectors/service.json")

type serviceReject struct {
	Line string `json:"line"`
	Why  string `json:"why"`
}

type serviceVector struct {
	Note        string          `json:"note"`
	Key         string          `json:"key"`
	Name        string          `json:"name"`
	Nd          string          `json:"nd"`
	Ng          string          `json:"ng"`
	Mesh        string          `json:"mesh"`
	Self        string          `json:"self"`
	Caller      vectorCaller    `json:"caller"`
	Line1       string          `json:"line1"`
	Answer      string          `json:"answer"`
	Line2       string          `json:"line2"`
	Identity    string          `json:"identity"`
	Proof       string          `json:"proof"`
	Line3       string          `json:"line3"`
	RejectLine1 []serviceReject `json:"rejectLine1"`
	RejectLine2 []serviceReject `json:"rejectLine2"`
	RejectLine3 []serviceReject `json:"rejectLine3"`
	// The v1.3 forms of line 3 for callers that are not members, under the same K, Nd and Ng.
	Client             vectorClient    `json:"client"`
	ClientIdentity     string          `json:"clientIdentity"`
	ClientProof        string          `json:"clientProof"`
	ClientLine3        string          `json:"clientLine3"`
	Pairing            vectorPairing   `json:"pairing"`
	PairingIdentity    string          `json:"pairingIdentity"`
	PairingProof       string          `json:"pairingProof"`
	PairingLine3       string          `json:"pairingLine3"`
	RejectClientLine3  []serviceReject `json:"rejectClientLine3"`
	RejectPairingLine3 []serviceReject `json:"rejectPairingLine3"`
}

// vectorClient is a listed client as J carries it.
type vectorClient struct {
	ID       string `json:"id"`
	NoisePub string `json:"noisePub"`
}

// vectorPairing is a pairing handshake as J carries it.
type vectorPairing struct {
	Invite   string `json:"invite"`
	NoisePub string `json:"noisePub"`
	SAS      string `json:"sas"`
}

// vectorCaller is the caller as J carries it.
type vectorCaller struct {
	NodeID   string `json:"nodeId"`
	SignPub  string `json:"signPub"`
	NoisePub string `json:"noisePub"`
	Name     string `json:"name"`
}

func fill(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

// buildServiceVector computes the local delivery for fixed inputs with the daemon's own functions.
func buildServiceVector(t *testing.T) serviceVector {
	t.Helper()
	key, nd, ng := fill(0x11), fill(0x22), fill(0x33)
	caller := mesh.Member{NodeID: "bbbbbbbbbbbbbbbbbbbbbbbbbb", SignPub: strictB64.EncodeToString(fill(0x44)),
		NoisePub: strictB64.EncodeToString(fill(0x55)), Name: "caller-1"}
	meshID, self, name := "mmmmmmmmmmmmmmmmmmmmmmmmmm", "ssssssssssssssssssssssssss", "goat"
	j, err := identityLine(meshID, self, caller, name)
	if err != nil {
		t.Fatal(err)
	}
	a := strictB64.EncodeToString(serviceMAC(key, "pen-svc/1 "+name, nd, ng))
	b := strictB64.EncodeToString(serviceMAC(key, "pen-svc/1 pen", nd, ng, j))
	ngs, nds := strictB64.EncodeToString(ng), strictB64.EncodeToString(nd)
	// line3 builds a line 3 whose MAC is right for its J, so a reader must refuse it for its shape.
	line3 := func(j string) string {
		return j + " " + strictB64.EncodeToString(serviceMAC(key, "pen-svc/1 pen", nd, ng, []byte(j))) + "\n"
	}
	js := string(j)
	client := vectorClient{ID: "dddddddddddddddddddddddddd", NoisePub: strictB64.EncodeToString(fill(0x66))}
	cj, err := clientIdentityLine(meshID, self, client.ID, client.NoisePub, name)
	if err != nil {
		t.Fatal(err)
	}
	pairing := vectorPairing{Invite: "0Fh_z1uKAGoODu_-", NoisePub: strictB64.EncodeToString(fill(0x88)),
		SAS: strictB64.EncodeToString(session.PairSAS(fill(0x77)))}
	pj, err := pairingIdentityLine(meshID, self, pairing.Invite, pairing.NoisePub, pairing.SAS, name)
	if err != nil {
		t.Fatal(err)
	}
	cjs, pjs := string(cj), string(pj)
	cb := strictB64.EncodeToString(serviceMAC(key, "pen-svc/1 pen", nd, ng, cj))
	pb := strictB64.EncodeToString(serviceMAC(key, "pen-svc/1 pen", nd, ng, pj))
	callerObj := `"caller":{"nodeId":"` + caller.NodeID + `","signPub":"` + caller.SignPub + `","noisePub":"` + caller.NoisePub + `","name":"caller-1"},`
	flip := func(s string) string { // the same 32 bytes with a non-zero trailing bit
		last := s[42]
		alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
		i := strings.IndexByte(alphabet, last)
		return s[:42] + string(alphabet[i|1])
	}
	return serviceVector{
		Note: "go test ./internal/daemon -run TestServiceVectors -update-service. Bytes are base64url without padding; " +
			"lines are exact wire bytes. Each reject line must be refused by the reader of that line.",
		Key: strictB64.EncodeToString(key), Name: name, Nd: nds, Ng: ngs, Mesh: meshID, Self: self,
		Caller: vectorCaller{NodeID: caller.NodeID, SignPub: caller.SignPub, NoisePub: caller.NoisePub, Name: caller.Name},
		Line1:  "PENSVC/1 " + nds + "\n", Answer: a, Line2: ngs + " " + a + "\n",
		Identity: js, Proof: b, Line3: js + " " + b + "\n",
		RejectLine1: []serviceReject{
			{"PENSVC/2 " + nds + "\n", "wrong prefix"},
			{"PENSVC/1 " + nds + "\r\n", "CR"},
			{"PENSVC/1 " + nds[:42] + "\n", "short nonce"},
			{"PENSVC/1 " + flip(nds) + "\n", "non-canonical base64url"},
			{"PENSVC/1 " + nds, "no LF"},
		},
		RejectLine2: []serviceReject{
			{ngs + " " + a + "\r\n", "CR"},
			{ngs + "  " + a + "\n", "two spaces"},
			{ngs + " " + a + "=\n", "padding"},
			{flip(ngs) + " " + a + "\n", "non-canonical base64url"},
			{ngs + " " + a[:42] + "\n", "short MAC"},
			{ngs + " " + a + " \n", "trailing space"},
		},
		RejectLine3: []serviceReject{
			{js + " " + b[:42] + "A\n", "wrong MAC"},
			{js + " " + b + "\r\n", "CR"},
			{line3(strings.Replace(js, `{"v":1,`, `{"v":1, `, 1)), "whitespace in J"},
			{line3(strings.Replace(js, `"v":1`, `"v":"1"`, 1)), "v is not a number"},
			{line3(strings.Replace(js, `,"stream":"goat"}`, `,"stream":"goat","extra":"x"}`, 1)), "unknown member"},
			{line3(strings.Replace(js, `,"stream":"goat"}`, `,"stream":"goat","stream":"goat"}`, 1)), "duplicate member"},
			{line3(strings.Replace(js, `,"stream":"goat"}`, "}", 1)), "missing member"},
			{line3(strings.Replace(js, `"name":"caller-1"}`, `"name":"caller-1","x":1}`, 1)), "unknown caller member"},
			{line3(strings.Replace(js, meshID, "nnnnnnnnnnnnnnnnnnnnnnnnnn", 1)), "mesh is not the pinned mesh"},
			{line3(strings.Replace(js, `"self":"`+self, `"self":"tttttttttttttttttttttttttt`, 1)), "self is not the pinned node"},
			{line3(strings.Replace(js, `"stream":"goat"`, `"stream":"other"`, 1)), "stream is not this service"},
			{line3(strings.Replace(js, `"name":"caller-1"`, `"name":"`+strings.Repeat("c", 2200)+`"`, 1)), "over 2,200 bytes"},
			{cjs + " " + cb + "\n", "a client line, which a member-only (v1.2) reader refuses"},
			{pjs + " " + pb + "\n", "a pairing line, which a member-only (v1.2) reader refuses"},
		},
		Client: client, ClientIdentity: cjs, ClientProof: cb, ClientLine3: cjs + " " + cb + "\n",
		Pairing: pairing, PairingIdentity: pjs, PairingProof: pb, PairingLine3: pjs + " " + pb + "\n",
		RejectClientLine3: []serviceReject{
			{cjs + " " + cb[:42] + "A\n", "wrong MAC"},
			{line3(strings.Replace(cjs, `"client":`, callerObj+`"client":`, 1)), "both caller and client"},
			{line3(strings.Replace(cjs, `,"stream":"goat"}`, `,"pairing":{"invite":"`+pairing.Invite+`","noisePub":"`+pairing.NoisePub+`","sas":"`+pairing.SAS+`"},"stream":"goat"}`, 1)), "both client and pairing"},
			{line3(strings.Replace(cjs, `"id":"`+client.ID+`",`, "", 1)), "client without id"},
			{line3(strings.Replace(cjs, `"},"stream"`, `","x":"y"},"stream"`, 1)), "unknown client member"},
			{line3(strings.Replace(cjs, client.ID, strings.ToUpper(client.ID), 1)), "id is not lowercase base32"},
			{line3(strings.Replace(cjs, client.NoisePub, flip(client.NoisePub), 1)), "non-canonical client key"},
			{line3(strings.Replace(cjs, `"id":"`+client.ID+`","noisePub":"`+client.NoisePub+`"`, `"noisePub":"`+client.NoisePub+`","id":"`+client.ID+`"`, 1)), "client members out of order"},
			{line3(strings.Replace(cjs, `"stream":"goat"`, `"stream":"other"`, 1)), "stream is not this service"},
			{line3(strings.Replace(cjs, meshID, "nnnnnnnnnnnnnnnnnnnnnnnnnn", 1)), "mesh is not the pinned mesh"},
		},
		RejectPairingLine3: []serviceReject{
			{pjs + " " + pb[:42] + "A\n", "wrong MAC"},
			{line3(strings.Replace(pjs, `"pairing":`, callerObj+`"pairing":`, 1)), "both caller and pairing"},
			{line3(strings.Replace(pjs, pairing.SAS, pairing.SAS[:42], 1)), "sas is 42 characters"},
			{line3(strings.Replace(pjs, pairing.Invite, pairing.Invite[:15], 1)), "invite is 15 characters"},
			{line3(strings.Replace(pjs, `","sas"`, `","x":"y","sas"`, 1)), "unknown pairing member"},
			{line3(strings.Replace(pjs, `,"sas":"`+pairing.SAS+`"`, "", 1)), "pairing without sas"},
			{line3(strings.Replace(pjs, pairing.NoisePub, flip(pairing.NoisePub), 1)), "non-canonical pairing key"},
			{line3(strings.Replace(pjs, `"self":"`+self, `"self":"tttttttttttttttttttttttttt`, 1)), "self is not the pinned node"},
		},
	}
}

func TestServiceVectors(t *testing.T) {
	got := buildServiceVector(t)
	path := filepath.Join("..", "..", "..", "..", "packages", "pen-protocol", "vectors", "service.json")
	if *updateServiceVectors {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want serviceVector
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if !bytes.Equal(g, w) {
		t.Fatal("service.json differs from what the daemon computes; run with -update-service after a deliberate change")
	}
	for _, bad := range [][5]string{
		{"mesh", "ssssssssssssssssssssssssss", "dddddddddddddddddddddddddd", want.Client.NoisePub, "goat"},
		{want.Mesh, want.Self, "DDDDDDDDDDDDDDDDDDDDDDDDDD", want.Client.NoisePub, "goat"},
		{want.Mesh, want.Self, want.Client.ID, want.Client.NoisePub + "=", "goat"},
		{want.Mesh, want.Self, want.Client.ID, want.Client.NoisePub, "pen"},
	} {
		if _, err := clientIdentityLine(bad[0], bad[1], bad[2], bad[3], bad[4]); err == nil {
			t.Fatalf("client line rendered for %q", bad)
		}
	}
	if _, err := pairingIdentityLine(want.Mesh, want.Self, want.Pairing.Invite[:15]+"=", want.Pairing.NoisePub, want.Pairing.SAS, "goat"); err == nil {
		t.Fatal("pairing line rendered for a bad invite id")
	}
	if _, err := pairingIdentityLine(want.Mesh, want.Self, want.Pairing.Invite, want.Pairing.NoisePub, want.Pairing.SAS[:42], "goat"); err == nil {
		t.Fatal("pairing line rendered for a short sas")
	}
	if _, _, err := parseAnswer([]byte(want.Line2)); err != nil {
		t.Fatalf("line 2 refused: %v", err)
	}
	for _, r := range want.RejectLine2 {
		line := []byte(r.Line)
		if i := bytes.IndexByte(line, '\n'); i >= 0 && i+1 < len(line) {
			t.Fatalf("reject %q has bytes after its LF", r.Why)
		}
		if _, _, err := parseAnswer(line); err == nil {
			t.Fatalf("line 2 reject %q was accepted", r.Why)
		}
	}
}
