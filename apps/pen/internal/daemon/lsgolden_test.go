package daemon

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/mesh"
)

// lsGolden is pen ls --json for lsFixture, recorded from origin/dev before traffic counters existed.
const lsGolden = `{
  "self": "id-a",
  "meshId": "mesh",
  "relay": "https://r1",
  "uplink": "up",
  "members": [
    {
      "nodeId": "id-a",
      "signPub": "S0",
      "noisePub": "N0",
      "name": "a",
      "since": 0,
      "fingerprint": "11111",
      "self": true,
      "online": true
    },
    {
      "nodeId": "id-b",
      "signPub": "S",
      "noisePub": "N",
      "name": "b",
      "admittedBy": "S0",
      "hostKeys": [
        "ssh-ed25519 AAAA"
      ],
      "user": "u",
      "since": 1700000000000,
      "via": "google",
      "email": "b@example.com",
      "fingerprint": "22222",
      "self": false,
      "online": true,
      "lastSeen": 1700000001000,
      "admittedByName": "a",
      "relay": "https://r1"
    }
  ],
  "revoked": [
    {
      "nodeId": "id-z",
      "signPub": "S9",
      "noisePub": "N9",
      "name": "z",
      "since": 0
    }
  ],
  "account": {
    "loginUrl": "https://login",
    "loginKey": {
      "kid": "",
      "pub": ""
    },
    "sub": "sub"
  },
  "locked": true,
  "pending": 2,
  "unforgotten": [
    {
      "nodeId": "id-z",
      "name": "z",
      "loginUrl": "https://login"
    }
  ],
  "saveError": "disk full",
  "records": 7,
  "hostKeysError": "unreadable"
}`

func lsFixture() LsReply {
	on := true
	m := mesh.Member{SignPub: "S", NoisePub: "N", NodeID: "id-b", Name: "b", User: "u", HostKeys: []string{"ssh-ed25519 AAAA"},
		AdmittedBy: "S0", Since: 1700000000000, Via: mesh.ViaGoogle, Email: "b@example.com"}
	return LsReply{
		Self: "id-a", MeshID: "mesh", Relay: "https://r1", Uplink: "up",
		Members: []LsMember{
			{Member: mesh.Member{SignPub: "S0", NoisePub: "N0", NodeID: "id-a", Name: "a"}, Fingerprint: "11111", Self: true, Online: true},
			{Member: m, Fingerprint: "22222", Online: true, LastSeen: 1700000001000, AdmittedByName: "a", Relay: "https://r1"},
		},
		Revoked:       []LsRevoked{{Member: mesh.Member{SignPub: "S9", NoisePub: "N9", NodeID: "id-z", Name: "z"}}},
		Account:       &mesh.Account{Sub: "sub", LoginURL: "https://login"},
		Locked:        on,
		Pending:       2,
		Unforgotten:   []Unforgotten{{NodeID: "id-z", Name: "z", LoginURL: "https://login"}},
		SaveError:     "disk full",
		Records:       7,
		HostKeysError: "unreadable",
		StateDir:      "/tmp/x",
	}
}

func TestLsJSONOfANodeWithNoTrafficKeepsEveryFieldByteForByte(t *testing.T) {
	b, err := json.MarshalIndent(lsFixture(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != lsGolden {
		t.Fatalf("pen ls --json changed for a node with no traffic:\n%s", b)
	}
}

// Traffic adds traffic24h to the members and revoked keys that carried bytes, and relays24h and trafficSince to the
// reply; without those, the output is what a node with no traffic prints.
func TestLsJSONWithTrafficOnlyAddsTrafficFields(t *testing.T) {
	ls := lsFixture()
	tr := &MemberTraffic{In: 1, Out: 2, Relays: []RelayTraffic{{URL: "https://r1", In: 1, Out: 2}}}
	ls.Members[1].Traffic24h, ls.Revoked[0].Traffic24h = tr, tr
	ls.Relays24h, ls.TrafficSince = tr.Relays, 5
	b, err := json.Marshal(ls)
	if err != nil {
		t.Fatal(err)
	}
	var got, want map[string]any
	json.Unmarshal(b, &got)
	json.Unmarshal([]byte(lsGolden), &want)
	delete(got, "relays24h")
	delete(got, "trafficSince")
	for _, k := range []string{"members", "revoked"} {
		for _, e := range got[k].([]any) {
			delete(e.(map[string]any), "traffic24h")
		}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pen ls --json with traffic, less its traffic fields:\n%s\nwant the no-traffic output", b)
	}
}
