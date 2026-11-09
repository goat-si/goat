// Command relaytest serves the in-process relay stand-in on a local port for scripted checks.
package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	flag.Parse()
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s := relaytest.NewUnstarted()
	fmt.Printf("url http://%s\n", ln.Addr())
	if err := http.Serve(ln, s.Handler()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

