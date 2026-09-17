package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// --- yolo -------------------------------------------------------------------
//
// Yolo is the operator saying "stop asking me": every `ask` tier in the
// consent gate becomes an allow, and pi is spawned trusting the project, so
// its own settings, extensions and skills load without a prompt.
//
// Two things it deliberately does NOT do, because the name promises more than
// it should be allowed to deliver:
//
//   - It does not override a `deny` rule. A deny is a decision the operator
//     already made; a mode that silently discarded it would be the one
//     surprise this system must never spring. The gate says how many denies
//     are still in force when it starts in this mode.
//   - It is not global by default. `/yolo on` writes the *project* file, so
//     full privileges belong to the work you turned them on for. Turning it on
//     everywhere stays a deliberate act: the global file, or MNEMO_YOLO=1.
//
// The file is the same one the consent dialog writes grants into, which is
// what makes the flip take effect in a running session: the agent watches that
// file, so this is a live switch rather than a restart.
const (
	permissionsDir  = ".mnemo"
	permissionsName = "permissions.json"
	yoloEnv         = "MNEMO_YOLO"
)

// YoloFile is the project-scoped permissions file.
func YoloFile(project string) string {
	return filepath.Join(project, permissionsDir, permissionsName)
}

// GlobalYoloFile is the user-scoped one.
func GlobalYoloFile(home string) string {
	return filepath.Join(home, permissionsDir, permissionsName)
}

// Yolo reports whether the mode is in force: the environment first, then the
// project, then the user — the nearest switch that is on wins, and none of
// them can turn another off.
func Yolo(project, home string) bool {
	if yoloFromEnv("") {
		return true
	}
	return fileSaysYolo(YoloFile(project)) || fileSaysYolo(GlobalYoloFile(home))
}

// YoloFromEnv is the environment read on its own, for callers that want to
// report where the mode came from.
func YoloFromEnv() bool { return yoloFromEnv("") }

func yoloFromEnv(_ string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(yoloEnv))) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// fileSaysYolo reads one file. A missing, unreadable or malformed file means
// "not on": a mode that turned itself on because a file was corrupt is exactly
// the failure this flag must not have.
func fileSaysYolo(file string) bool {
	raw, err := os.ReadFile(file)
	if err != nil {
		return false
	}
	var doc struct {
		Yolo bool `json:"yolo"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	return doc.Yolo
}

// SetProjectYolo turns the mode on or off for one project and returns the file
// it wrote.
//
// The document is edited as a map rather than re-encoded from a typed struct:
// this file also holds the rules the consent dialog wrote, and rewriting it
// from a struct that does not know about every key would quietly delete them —
// the rules a person granted would vanish the first time they toggled a mode.
func SetProjectYolo(project string, on bool) (string, error) {
	file := YoloFile(project)
	doc := map[string]any{}
	if raw, err := os.ReadFile(file); err == nil {
		_ = json.Unmarshal(raw, &doc)
	}
	if _, ok := doc["version"]; !ok {
		doc["version"] = 1
	}
	if _, ok := doc["default"]; !ok {
		doc["default"] = "ask"
	}
	if _, ok := doc["rules"]; !ok {
		doc["rules"] = []any{}
	}
	doc["yolo"] = on

	body, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	// Beside-and-rename, for the reason the agent's writer exists: the agent
	// watches this file, and a reader that opens it mid-write sees an empty
	// document, which for a permissions file means "nothing is granted".
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, append(body, '\n'), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, file); err != nil {
		return "", err
	}
	return file, nil
}
