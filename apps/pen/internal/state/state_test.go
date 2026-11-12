package state

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestV1ConfigWithOneRelayMigratesToRelaysAndKeepsWritingRelay(t *testing.T) {
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v1 := []byte("{\"relay\":\"https://a.example\",\"name\":\"n\"}")
	if err := os.WriteFile(st.Path("config.json"), v1, 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := st.LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if got := c.RelayList(); !reflect.DeepEqual(got, []string{"https://a.example"}) {
		t.Fatalf("relays %v, want the v1 relay", got)
	}
	c.SetRelays([]string{"https://b.example", "https://c.example"})
	if err := st.SaveConfig(c); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	b, _ := os.ReadFile(st.Path("config.json"))
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatal(err)
	}
	if raw["relay"] != "https://b.example" || !reflect.DeepEqual(raw["relays"], []any{"https://b.example", "https://c.example"}) {
		t.Fatalf("saved %s", b)
	}
}
