// Command logintest runs the fake login service for scripts (loginnode.sh). It prints "url <URL>"
// once it listens and approves every device flow for the --approve account.
package main

import (
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/goat-si/goat/apps/pen/internal/logintest"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:0", "address to listen on")
	approve := flag.String("approve", "", "sub,email to approve every sign-in as")
	flag.Parse()
	s := logintest.New()
	if *approve != "" {
		acct, ok := logintest.SplitAccount(*approve)
		if !ok {
			fmt.Fprintln(os.Stderr, "logintest: --approve wants sub,email")
			os.Exit(2)
		}
		s.AutoApprove = &acct
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "logintest:", err)
		os.Exit(1)
	}
	s.URL = "http://" + ln.Addr().String()
	fmt.Println("url", s.URL)
	fmt.Fprintln(os.Stderr, http.Serve(ln, s))
	os.Exit(1)
}
