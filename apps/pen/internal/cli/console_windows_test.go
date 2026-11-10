package cli

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// TestHelperJobChild is the supervisor stand-in of the test below: it joins the kill-on-close job, starts
// a grandchild, prints its pid and blocks until it is killed.
func TestHelperJobChild(t *testing.T) {
	if os.Getenv("PEN_TEST_JOB") != "child" {
		return
	}
	if err := killChildrenWithMe(); err != nil {
		fmt.Println("job:", err)
		os.Exit(3)
	}
	g := exec.Command(os.Args[0], "-test.run=^TestHelperJobGrandchild$")
	g.Env = append(os.Environ(), "PEN_TEST_JOB=grandchild")
	if err := g.Start(); err != nil {
		fmt.Println("start:", err)
		os.Exit(3)
	}
	fmt.Println(g.Process.Pid)
	select {}
}

// TestHelperJobGrandchild stands in for the daemon: it never exits by itself.
func TestHelperJobGrandchild(t *testing.T) {
	if os.Getenv("PEN_TEST_JOB") != "grandchild" {
		return
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(3)
	}
	ln.Accept()
	os.Exit(0)
}

// schtasks /End ends the supervisor; a daemon it started, even one still starting, must end with it, or
// pen down would leave a daemon nobody stops.
func TestADaemonEndsWithItsSupervisor(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperJobChild$")
	cmd.Env = append(os.Environ(), "PEN_TEST_JOB=child")
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(out).ReadString('\n')
	pid, perr := strconv.Atoi(strings.TrimSpace(line))
	if err != nil || perr != nil {
		cmd.Process.Kill()
		t.Fatalf("supervisor stand-in said %q (%v)", line, err)
	}
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	cmd.Process.Kill()
	cmd.Wait()
	ev, err := windows.WaitForSingleObject(h, 10000)
	if err != nil || ev != windows.WAIT_OBJECT_0 {
		windows.TerminateProcess(h, 1)
		t.Fatalf("the daemon stand-in %d outlived its supervisor (wait %d, %v)", pid, ev, err)
	}
}
