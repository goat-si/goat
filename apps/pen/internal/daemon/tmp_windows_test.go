package daemon

import "os"

func tmpRoot() string { return os.TempDir() }
