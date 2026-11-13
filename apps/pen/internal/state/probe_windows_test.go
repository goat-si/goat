package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Diagnostic only (never merged): what a Windows runner does with readers while another handle holds a file.
// It never fails on its findings; one Errorf at the end makes go test print the log.

func probeErr(err error) string {
	if err == nil {
		return "ok"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("errno %d (%v) %#v", uint32(errno), err, err)
	}
	return fmt.Sprintf("%v %#v", err, err)
}

func probeU16(t *testing.T, s string) *uint16 {
	p, err := windows.UTF16PtrFromString(s)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func probeFinal(h windows.Handle) string {
	buf := make([]uint16, 1024)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "final path: " + probeErr(err)
	}
	return windows.UTF16ToString(buf[:n])
}

func probeID(h windows.Handle) string {
	var fi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &fi); err != nil {
		return "file id: " + probeErr(err)
	}
	return fmt.Sprintf("vol %#x idx %#x:%#x links %d", fi.VolumeSerialNumber, fi.FileIndexHigh, fi.FileIndexLow, fi.NumberOfLinks)
}

func probeVolume(t *testing.T, dir string) {
	root := make([]uint16, 512)
	if err := windows.GetVolumePathName(probeU16(t, dir), &root[0], uint32(len(root))); err != nil {
		t.Logf("volume of %s: %s", dir, probeErr(err))
		return
	}
	r := windows.UTF16ToString(root)
	name, fs := make([]uint16, 256), make([]uint16, 256)
	var serial, maxLen, flags uint32
	err := windows.GetVolumeInformation(&root[0], &name[0], uint32(len(name)), &serial, &maxLen, &flags, &fs[0], uint32(len(fs)))
	t.Logf("volume of %s: root %s name %q fs %q flags %#x serial %#x err %s", dir, r, windows.UTF16ToString(name),
		windows.UTF16ToString(fs), flags, serial, probeErr(err))
	parts := strings.Split(filepath.Clean(dir), string(filepath.Separator))
	for i := 1; i <= len(parts); i++ {
		p := strings.Join(parts[:i], string(filepath.Separator))
		if i == 1 {
			p += string(filepath.Separator)
		}
		attrs, err := windows.GetFileAttributes(probeU16(t, p))
		fi, lerr := os.Lstat(p)
		mode := "?"
		if lerr == nil {
			mode = fi.Mode().String()
		}
		t.Logf("  component %s attrs %#x reparse %v mode %s err %s", p, attrs, attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0, mode, probeErr(err))
	}
}

type probeHolder struct {
	name string
	open func(t *testing.T, path string) (windows.Handle, func(), error)
}

func probeCreate(access, share uint32) func(t *testing.T, path string) (windows.Handle, func(), error) {
	return func(t *testing.T, path string) (windows.Handle, func(), error) {
		h, err := windows.CreateFile(probeU16(t, path), access, share, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			return 0, nil, err
		}
		return h, func() { windows.CloseHandle(h) }, nil
	}
}

var probeHolders = []probeHolder{
	{"CreateFile GENERIC_READ share 0", probeCreate(windows.GENERIC_READ, 0)},
	{"CreateFile GENERIC_READ|GENERIC_WRITE share 0", probeCreate(windows.GENERIC_READ|windows.GENERIC_WRITE, 0)},
	{"CreateFile DELETE share 0", probeCreate(windows.DELETE, 0)},
	{"os.OpenFile O_RDWR", func(t *testing.T, path string) (windows.Handle, func(), error) {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			return 0, nil, err
		}
		return windows.Handle(f.Fd()), func() { f.Close() }, nil
	}},
	{"CreateFile DELETE share all, delete pending (a replaced target)", func(t *testing.T, path string) (windows.Handle, func(), error) {
		h, err := windows.CreateFile(probeU16(t, path), windows.DELETE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
			nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			return 0, nil, err
		}
		del := byte(1)
		if err := windows.SetFileInformationByHandle(h, windows.FileDispositionInfo, &del, uint32(unsafe.Sizeof(del))); err != nil {
			windows.CloseHandle(h)
			return 0, nil, fmt.Errorf("delete disposition: %w", err)
		}
		return h, func() { windows.CloseHandle(h) }, nil
	}},
}

func probeReads(t *testing.T, path string) []string {
	var out []string
	_, err := os.ReadFile(path)
	out = append(out, "os.ReadFile="+probeErr(err))
	if f, err := os.Open(path); err != nil {
		out = append(out, "os.Open="+probeErr(err))
	} else {
		h := windows.Handle(f.Fd())
		out = append(out, "os.Open=ok ["+probeFinal(h)+"; "+probeID(h)+"]")
		f.Close()
	}
	if h, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_CLOEXEC, 0); err != nil {
		out = append(out, "syscall.Open="+probeErr(err))
	} else {
		out = append(out, "syscall.Open=ok")
		syscall.CloseHandle(h)
	}
	goExact := uint32(windows.FILE_ATTRIBUTE_NORMAL | windows.FILE_FLAG_BACKUP_SEMANTICS)
	if h, err := windows.CreateFile(probeU16(t, path), windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_EXISTING, goExact, 0); err != nil {
		out = append(out, "CreateFile(Go's flags)="+probeErr(err))
	} else {
		out = append(out, "CreateFile(Go's flags)=ok")
		windows.CloseHandle(h)
	}
	if h, err := windows.CreateFile(probeU16(t, path), windows.GENERIC_READ, windows.FILE_SHARE_READ, nil,
		windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0); err != nil {
		out = append(out, "CreateFile(share read only)="+probeErr(err))
	} else {
		out = append(out, "CreateFile(share read only)=ok")
		windows.CloseHandle(h)
	}
	return out
}

func TestWindowsProbe(t *testing.T) {
	t.Logf("go %s GOOS %s GOARCH %s GODEBUG=%q", runtime.Version(), runtime.GOOS, runtime.GOARCH, os.Getenv("GODEBUG"))
	plain := t.TempDir()
	st, err := OpenDir(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	probeVolume(t, plain)
	probeVolume(t, st.Dir)
	dirs := []struct {
		name  string
		write func(name string) (string, error)
	}{
		{"plain TempDir, os.WriteFile", func(name string) (string, error) {
			p := filepath.Join(plain, name)
			return p, os.WriteFile(p, []byte(`{"name":"n"}`), 0o600)
		}},
		{"OpenDir TempDir, WriteAtomic (the failing test's setup)", func(name string) (string, error) {
			return st.Path(name), st.WriteAtomic(name, []byte(`{"name":"n"}`), 0o600)
		}},
	}
	for di, d := range dirs {
		p, err := d.write("baseline.json")
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("[%s] no holder: %s", d.name, strings.Join(probeReads(t, p), " | "))
		for hi, h := range probeHolders {
			p, err := d.write(fmt.Sprintf("f%d-%d.json", di, hi))
			if err != nil {
				t.Fatal(err)
			}
			hd, done, err := h.open(t, p)
			if err != nil {
				t.Logf("[%s] holder %q: open %s", d.name, h.name, probeErr(err))
				continue
			}
			meta, merr := windows.CreateFile(probeU16(t, p), 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
				nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
			metaInfo := "metadata handle: " + probeErr(merr)
			if merr == nil {
				metaInfo = "metadata handle: " + probeFinal(meta) + "; " + probeID(meta)
				windows.CloseHandle(meta)
			}
			t.Logf("[%s] holder %q: path %s; holder %s; %s; %s", d.name, h.name, p, probeFinal(hd), probeID(hd), metaInfo)
			t.Logf("[%s] holder %q reads: %s", d.name, h.name, strings.Join(probeReads(t, p), " | "))
			done()
		}
	}
	t.Errorf("windows probe done: deliberate failure so go test prints the lines above")
}
