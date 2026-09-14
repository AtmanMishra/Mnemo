package memory

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The fixtures here stand in for memsrv.
//
// They used to be `#!/bin/sh` scripts written into a temp directory, which made
// this package un-runnable on Windows: there is no shebang, no POSIX shell, and
// a file with no extension is not executable. Instead the tests re-exec THIS
// test binary as the fake sidecar — the protocol under test is a line of JSON
// in and a line of JSON out, and nothing about it needs a shell. One code path,
// every platform.
const (
	envFakeSrv  = "MNEMO_TEST_FAKESRV"
	envFakeSpec = "MNEMO_TEST_FAKE_SPEC"
)

// TestMain is also the fake sidecar's entry point: when the environment says
// so, this process is the sidecar and never the test runner.
func TestMain(m *testing.M) {
	if os.Getenv(envFakeSrv) == "1" {
		os.Exit(fakeSrvMain())
	}
	os.Exit(m.Run())
}

// fakeSpec describes what the stand-in sidecar does with each request. Zero
// values are the plain case: read a line, answer it with "result".
type fakeSpec struct {
	Result  string `json:"result,omitempty"`  // raw JSON for the reply's "result"
	Error   string `json:"error,omitempty"`   // message for an ok:false reply
	Capture string `json:"capture,omitempty"` // file to write each request line into

	Stray     bool `json:"stray,omitempty"`         // emit a non-JSON line before each reply
	Die       bool `json:"die,omitempty"`           // exit before reading anything
	Once      bool `json:"once,omitempty"`          // answer one request, then exit
	DelayOnce int  `json:"delay_once_ms,omitempty"` // hold back the reply to id 1
}

var fakeID = regexp.MustCompile(`"id"\s*:\s*([0-9]+)`)

func fakeSrvMain() int {
	var spec fakeSpec
	if err := json.Unmarshal([]byte(os.Getenv(envFakeSpec)), &spec); err != nil {
		fmt.Fprintln(os.Stderr, "fake sidecar: bad spec:", err)
		return 2
	}
	if spec.Die {
		return 1
	}
	in := bufio.NewReader(os.Stdin)
	for {
		line, err := in.ReadString('\n')
		if line != "" {
			if strings.Contains(line, `"exit"`) {
				return 0
			}
			if spec.Capture != "" {
				_ = os.WriteFile(spec.Capture, []byte(strings.TrimRight(line, "\r\n")+"\n"), 0o644)
			}
			id := 1
			if m := fakeID.FindStringSubmatch(line); m != nil {
				if n, convErr := strconv.Atoi(m[1]); convErr == nil {
					id = n
				}
			}
			if spec.Stray {
				fmt.Println("loading journal...")
			}
			if spec.DelayOnce > 0 && id == 1 {
				time.Sleep(time.Duration(spec.DelayOnce) * time.Millisecond)
			}
			if spec.Error != "" {
				msg, _ := json.Marshal(spec.Error)
				fmt.Printf("{\"id\":%d,\"ok\":false,\"error\":%s}\n", id, msg)
			} else {
				result := spec.Result
				if result == "" {
					result = "{}"
				}
				fmt.Printf("{\"id\":%d,\"ok\":true,\"result\":%s}\n", id, result)
			}
			if spec.Once {
				return 0
			}
		}
		if err != nil {
			return 0
		}
	}
}

// fakeSrv arms the given behaviour and returns the path to run: this test
// binary, re-executed. The env carries the spec, and it is read once at
// startup, so a test that opens a second client with a different spec does not
// disturb the first one.
func fakeSrv(t *testing.T, spec fakeSpec) string {
	t.Helper()
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(envFakeSrv, "1")
	t.Setenv(envFakeSpec, string(raw))
	return os.Args[0]
}

// echoSrv replies to every request with the same result, echoing the id back.
func echoSrv(t *testing.T, result string) string {
	t.Helper()
	return fakeSrv(t, fakeSpec{Result: result})
}
