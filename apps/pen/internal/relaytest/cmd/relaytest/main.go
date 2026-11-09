// Command relaytest serves the in-process relay stand-in on a local port for scripted checks.
// With -public it also serves a directory (install.sh, dl/) as the relay's static assets do.
package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/goat-si/goat/apps/pen/internal/relaytest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:0", "listen address")
	public := flag.String("public", "", "directory to serve for paths outside /v1/ and /healthz")
	flag.Parse()
	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s := relaytest.NewUnstarted()
	var h http.Handler = s.Handler()
	if *public != "" {
		files := http.FileServer(http.Dir(*public))
		relay := h
		h = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/v1/") || r.URL.Path == "/healthz" {
				relay.ServeHTTP(w, r)
				return
			}
			files.ServeHTTP(w, r)
		})
	}
	fmt.Printf("url http://%s\n", ln.Addr())
	if err := http.Serve(ln, h); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
