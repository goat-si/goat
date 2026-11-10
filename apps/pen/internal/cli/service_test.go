package cli

import (
	"encoding/xml"
	"io"
	"os"
	"strings"
	"testing"
)

func template(t *testing.T, name string) string {
	b, err := os.ReadFile("../../install/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// plistStrings decodes every <string> of a plist the way an XML parser such as launchd's reads it.
func plistStrings(t *testing.T, doc string) []string {
	var out []string
	d := xml.NewDecoder(strings.NewReader(doc))
	for {
		tok, err := d.Token()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatalf("the plist is not well-formed XML: %v", err)
		}
		if se, ok := tok.(xml.StartElement); ok && se.Name.Local == "string" {
			var s string
			if err := d.DecodeElement(&s, &se); err != nil {
				t.Fatal(err)
			}
			out = append(out, s)
		}
	}
}

func TestThePlistKeepsAnExecutablePathWithMarkupCharactersExact(t *testing.T) {
	exe, home := "/Users/x/A & B <c>/pen", "/Users/x & y"
	doc, err := fill(template(t, "si.goat.pen.plist"), true, exe, home)
	if err != nil {
		t.Fatal(err)
	}
	got := plistStrings(t, doc)
	if len(got) < 2 || got[1] != exe {
		t.Fatalf("ProgramArguments[0] reads back as %q, want %q", got, exe)
	}
	if last := got[len(got)-1]; last != home+"/.pen/daemon.log" {
		t.Fatalf("the log path reads back as %q", last)
	}
}

func TestTheUnitQuotesTheExecutablePathForSystemd(t *testing.T) {
	doc, err := fill(template(t, "pen.service"), false, `/home/x/My Apps/100%/$HOME/a"b\c/pen`, "/home/x")
	if err != nil {
		t.Fatal(err)
	}
	want := `ExecStart="/home/x/My Apps/100%%/$$HOME/a\"b\\c/pen" up --foreground --service`
	if !strings.Contains(doc, want+"\n") {
		t.Fatalf("unit:\n%s\nwant the line %s", doc, want)
	}
}

func TestAServiceIsNotWrittenForAPathWithALineBreak(t *testing.T) {
	if _, err := fill(template(t, "pen.service"), false, "/home/x/a\nExecStartPre=/bin/evil", "/home/x"); err == nil {
		t.Fatal("a path with a line break was written into the unit")
	}
}
