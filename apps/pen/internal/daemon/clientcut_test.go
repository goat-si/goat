package daemon

import (
	"testing"

	"github.com/goat-si/goat/apps/pen/internal/stream"
)

func TestAClientStreamTheRelayCutsResetsTheProgramInsteadOfEndingItCleanly(t *testing.T) {
	f := newClientFixture(t)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.ended = make(chan error, 1)
	prog.serve()
	f.h = register(t, f.a, "goat", prog.port(), key)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := sec.Send(append([]byte{stream.TypeData}, "partial"...)); err != nil {
		t.Fatal(err)
	}
	if _, err := sec.Recv(f.ctx); err != nil { // the program's echo: it holds the stream
		t.Fatal(err)
	}
	if !f.rs.DropUplink(f.a.id.NodeID()) {
		t.Fatal("the node has no uplink to drop")
	}
	if err := <-prog.ended; err == nil {
		t.Fatal("the program read the end of the phone's stream after the relay cut it; want a reset")
	}
}

func TestAClientStreamThatEndsWithTheirFinReachesTheProgramAsACleanEnd(t *testing.T) {
	f := newClientFixture(t)
	key := newKey(t)
	prog := newProgram(t, "goat", key)
	prog.ended = make(chan error, 1)
	prog.serve()
	f.h = register(t, f.a, "goat", prog.port(), key)
	p := phone(t)
	f.h.setList(t, 1, p)
	sec, err := dialAs(f.ctx, f.rs, p, f.a, goatService())
	if err != nil {
		t.Fatal(err)
	}
	if err := sec.Send(append([]byte{stream.TypeData}, "whole"...)); err != nil {
		t.Fatal(err)
	}
	if err := sec.Send([]byte{stream.TypeFin}); err != nil {
		t.Fatal(err)
	}
	if err := <-prog.ended; err != nil {
		t.Fatalf("the program's copy ended with %v after the phone's FIN; want a clean end", err)
	}
}
