package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/goat-si/goat/apps/pen/internal/ident"
	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

// opsOnce registers name, sends ops in the same write as the request, half-closes, and returns every line the node
// sent after "registered" until it closed the connection. A node that does not read ops ends the registration at the
// half-close, so it returns no answers rather than hanging.
func opsOnce(t *testing.T, n *node, name string, ops ...string) []map[string]any {
	t.Helper()
	key := newKey(t)
	req, _ := json.Marshal(map[string]any{"op": "service.register", "name": name, "port": 1, "key": ident.B64.EncodeToString(key)})
	c, err := net.Dial("unix", SocketPath(n.st))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, err := c.Write([]byte(string(req) + "\n" + strings.Join(append(ops, ""), "\n"))); err != nil {
		t.Fatal(err)
	}
	if err := c.(*net.UnixConn).CloseWrite(); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(c)
	var out []map[string]any
	for first := true; ; first = false {
		line, err := r.ReadBytes('\n')
		if err != nil {
			// The registration ends with a clean EOF: a reset can discard answers the holder has not read yet.
			if !errors.Is(err, io.EOF) {
				t.Fatalf("after %d answer(s) the registration ended with %v, want EOF", len(out), err)
			}
			return out
		}
		var m map[string]any
		if err := json.Unmarshal(line, &m); err != nil {
			t.Fatalf("line %q: %v", line, err)
		}
		if first {
			if m["t"] != "registered" {
				t.Fatalf("register answered %v", m)
			}
			continue
		}
		out = append(out, m)
	}
}

// answersAre compares answers with want, ignoring refusals' reason text (contract: diagnostic only) after checking
// that it is a non-empty string.
func answersAre(t *testing.T, got []map[string]any, want ...map[string]any) {
	t.Helper()
	for _, g := range got {
		if g["t"] == "refused" {
			if r, ok := g["reason"].(string); !ok || r == "" {
				t.Errorf("refusal without a reason: %v", g)
			}
			delete(g, "reason")
		}
	}
	if len(got) != len(want) {
		t.Fatalf("got %d answers, want %d:\n got %v\nwant %v", len(got), len(want), got, want)
	}
	for i := range want {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Errorf("answer %d: got %v, want %v", i, got[i], want[i])
		}
	}
}

func listOp(gen any, entries ...string) string {
	return fmt.Sprintf(`{"op":"service.clients","gen":%v,"clients":[%s]}`, gen, strings.Join(entries, ","))
}

func entry(id, key string) string { return `{"id":"` + id + `","noisePub":"` + key + `"}` }

func clientID(i int) string {
	return strings.Repeat("a", 24) + string(rune('a'+i/26)) + string(rune('a'+i%26))
}

func fresh(t *testing.T) string { return ident.B64.EncodeToString(newKey(t)) }

func clientsAnswer(gen float64) map[string]any { return map[string]any{"t": "clients", "gen": gen} }

func refusedAnswer(op string, extra ...any) map[string]any {
	m := map[string]any{"t": "refused", "op": op}
	for i := 0; i+1 < len(extra); i += 2 {
		m[extra[i].(string)] = extra[i+1]
	}
	return m
}

func TestTheClientListGenerationMustRiseWithinARegistrationAndAnyValueStartsANewOne(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	answersAre(t, opsOnce(t, a, "goat", listOp(5), listOp(5), listOp(4), listOp(6)),
		clientsAnswer(5), refusedAnswer("service.clients", "gen", 5.0), refusedAnswer("service.clients", "gen", 4.0), clientsAnswer(6))
	answersAre(t, opsOnce(t, a, "goat", listOp(1)), clientsAnswer(1))
	answersAre(t, opsOnce(t, a, "goat", listOp(9007199254740991), listOp(2)),
		clientsAnswer(9007199254740991), refusedAnswer("service.clients", "gen", 2.0))
}

func TestClientListOpsAreParsedExactlyAndARefusalCarriesOnlyTheFieldsItCanTrust(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	joiner(t, ctx, rs, a.invite(t, time.Minute), "b")
	joiner(t, ctx, rs, a.invite(t, time.Minute), "c")
	cm := memberNamed(t, a, "c")
	var out struct{ Results []PushResult }
	if err := Call(a.st, Request{Op: "revoke", Subject: cm.SignPub}, &out); err != nil {
		t.Fatal(err)
	}
	self := ident.B64.EncodeToString(a.id.NoisePub)
	member := memberNamed(t, a, "b").NoisePub
	k1, k2 := fresh(t), fresh(t)
	var nine []string
	for i := range 9 {
		nine = append(nine, entry(clientID(i), fresh(t)))
	}
	cl := "service.clients"
	answersAre(t, opsOnce(t, a, "goat",
		"not json",
		`{"op":"service.clients","gen":1,"clients":[],"extra":1}`,
		`{"op":"service.clients","gen":1,"gen":2,"clients":[]}`,
		`{"op":"service.other","gen":1}`,
		`["service.clients"]`,
		listOp(0), listOp(1.5), listOp(`"1"`), listOp("1e0"), listOp(-1), listOp("9007199254740992"),
		`{"op":"service.clients","gen":1}`,
		listOp(1, nine...),
		listOp(1, entry(strings.ToUpper(clientID(0)), k1)),
		listOp(1, entry(clientID(0), k1), entry(clientID(0), k2)),
		listOp(1, entry(clientID(0), k1), entry(clientID(1), k1)),
		listOp(1, entry(clientID(0), flipKey(k1))),
		listOp(1, entry(clientID(0), k1+"=")),
		listOp(1, entry(clientID(0), self)),
		listOp(1, entry(clientID(0), member)),
		listOp(1, entry(clientID(0), cm.NoisePub)),
		listOp(1, `{"id":"`+clientID(0)+`","noisePub":"`+k1+`","name":"x"}`),
		listOp(1, entry(clientID(0), k1), entry(clientID(1), k2)),
		listOp(1),
	),
		refusedAnswer(""), refusedAnswer(cl, "gen", 1.0), refusedAnswer(""), refusedAnswer(""), refusedAnswer(""),
		refusedAnswer(cl), refusedAnswer(cl), refusedAnswer(cl), refusedAnswer(cl), refusedAnswer(cl), refusedAnswer(cl),
		refusedAnswer(cl, "gen", 1.0),
		refusedAnswer(cl, "gen", 1.0),
		refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0),
		refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0),
		refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0), refusedAnswer(cl, "gen", 1.0),
		clientsAnswer(1),
		refusedAnswer(cl, "gen", 1.0),
	)
}

// flipKey is the same 32 bytes written with a non-zero trailing bit, which is not canonical.
func flipKey(s string) string {
	alphabet := "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	return s[:42] + string(alphabet[strings.IndexByte(alphabet, s[42])|1])
}

func inviteOp(id, psk string, at any) string {
	return fmt.Sprintf(`{"op":"service.invite","id":"%s","psk":"%s","expiresAt":%v}`, id, psk, at)
}

func cancelOp(id string) string { return `{"op":"service.invite.cancel","id":"` + id + `"}` }

func TestServiceInviteOpsHoldOneInviteAndSayWhatACancelFound(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	now := clk.ms.Load()
	psk := fresh(t)
	i1, i2, i3 := "AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"
	inv, can := "service.invite", "service.invite.cancel"
	in5 := now + 5*60*1000
	answersAre(t, opsOnce(t, a, "goat",
		inviteOp("AAAAAAAAAAAAAAA", psk, in5),
		inviteOp("AAAAAAAAAAAAAAA+", psk, in5),
		inviteOp(i1, flipKey(psk), in5),
		inviteOp(i1, psk, now),
		inviteOp(i1, psk, now+10*60*1000+1),
		inviteOp(i1, psk, fmt.Sprint(in5)+".5"),
		`{"op":"service.invite","id":"`+i1+`","psk":"`+psk+`"}`,
		inviteOp(i1, psk, now+10*60*1000),
		inviteOp(i1, psk, in5),
		inviteOp(i2, psk, in5),
		cancelOp(i1),
		cancelOp(i2),
		cancelOp(i2),
		cancelOp("short"),
		`{"op":"service.invite.cancel","id":"`+i3+`","x":1}`,
	),
		refusedAnswer(inv), refusedAnswer(inv),
		refusedAnswer(inv, "id", i1), refusedAnswer(inv, "id", i1), refusedAnswer(inv, "id", i1), refusedAnswer(inv, "id", i1),
		refusedAnswer(inv, "id", i1),
		map[string]any{"t": "invite", "id": i1},
		refusedAnswer(inv, "id", i1),
		map[string]any{"t": "invite", "id": i2},
		map[string]any{"t": "invite-cancelled", "id": i1, "was": "absent"},
		map[string]any{"t": "invite-cancelled", "id": i2, "was": "live"},
		map[string]any{"t": "invite-cancelled", "id": i2, "was": "absent"},
		refusedAnswer(can),
		refusedAnswer(can, "id", i3),
	)
}

func TestAnInviteThatExpiredIsAbsentToACancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	clk := &clock{}
	clk.ms.Store(time.Now().UnixMilli())
	a := founder(t, ctx, rs, "a", clk)
	id := "AAAAAAAAAAAAAAAA"
	key := newKey(t)
	h := register(t, a, "goat", 1, key)
	op := func(line string) map[string]any {
		t.Helper()
		if _, err := h.c.Write([]byte(line + "\n")); err != nil {
			t.Fatal(err)
		}
		m, ok := h.next(t)
		if !ok {
			t.Fatalf("no answer to %s", line)
		}
		return m
	}
	if m := op(inviteOp(id, fresh(t), clk.ms.Load()+60_000)); m["t"] != "invite" {
		t.Fatalf("invite answered %v", m)
	}
	clk.advance(time.Minute)
	if m := op(cancelOp(id)); m["was"] != "absent" {
		t.Fatalf("cancel of an expired invite answered %v, want was absent", m)
	}
}

func TestARegistrationOfAnotherNameRefusesEveryClientAndInviteOp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	answersAre(t, opsOnce(t, a, "other", listOp(1), inviteOp("AAAAAAAAAAAAAAAA", fresh(t), time.Now().UnixMilli()+60_000), cancelOp("AAAAAAAAAAAAAAAA")),
		refusedAnswer("service.clients", "gen", 1.0), refusedAnswer("service.invite", "id", "AAAAAAAAAAAAAAAA"),
		refusedAnswer("service.invite.cancel", "id", "AAAAAAAAAAAAAAAA"))
}

func TestAnOpLineOf4096BytesIsReadAndALongerOneEndsTheRegistration(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	pad := func(op string, total int) string { // total bytes with the LF
		return op[:len(op)-1] + strings.Repeat(" ", total-1-len(op)) + "}"
	}
	answersAre(t, opsOnce(t, a, "goat", pad(listOp(1), 4096), pad(listOp(2), 4097), listOp(3)), clientsAnswer(1))
}

func TestMoreThan64KiBOfOpsOnOneRegistrationAreAllAnswered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rs := relaytest.New()
	defer rs.Close()
	a := founder(t, ctx, rs, "a", nil)
	var ops []string
	var want []map[string]any
	total := 0
	for g := 1; total <= 64<<10; g++ {
		var es []string
		for i := range 8 {
			es = append(es, entry(clientID(i), fresh(t)))
		}
		op := listOp(g, es...)
		total += len(op) + 1
		ops = append(ops, op)
		want = append(want, clientsAnswer(float64(g)))
	}
	answersAre(t, opsOnce(t, a, "goat", ops...), want...)
}
