// Package filetree turns a directory into tree.Nodes, lazily.
//
// It is deliberately thin: the hierarchy, the keys and the rendering all
// belong to internal/tree. This package's only job is knowing what a
// directory contains and what is not worth showing.
package filetree

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/tree"
)

// Skip is the set of directory names never worth walking in a code tree.
// Opening a repository and seeing node_modules first is the explorer being
// useless in exactly the situation you opened it.
var Skip = map[string]bool{
	".git": true, "node_modules": true, "target": true, "dist": true,
	"build": true, ".venv": true, "venv": true, "__pycache__": true,
	".next": true, ".cache": true, "vendor": true, ".DS_Store": true,
}

// Root builds a node for a directory. Children load on first open.
func Root(path string) *tree.Node {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	n := dir(abs, filepath.Base(abs))
	n.Expanded = true
	return n
}

func dir(path, label string) *tree.Node {
	n := &tree.Node{ID: path, Label: label, Kind: tree.Dir}
	n.Load = func() []*tree.Node { return children(path) }
	return n
}

func children(path string) []*tree.Node {
	ents, err := os.ReadDir(path)
	if err != nil {
		// A directory we cannot read is a fact worth showing, not a silent
		// empty node — otherwise a permissions problem looks like an empty
		// folder and you go looking for the missing files.
		return []*tree.Node{{ID: path + "!", Label: "· " + errText(err), Kind: tree.Plain, State: tree.Failed}}
	}
	var dirs, files []*tree.Node
	for _, e := range ents {
		name := e.Name()
		if Skip[name] || strings.HasPrefix(name, ".") && name != ".claude" {
			continue
		}
		p := filepath.Join(path, name)
		if e.IsDir() {
			dirs = append(dirs, dir(p, name))
			continue
		}
		f := &tree.Node{ID: p, Label: name, Kind: tree.File}
		if info, err := e.Info(); err == nil {
			f.Detail = size(info.Size())
		}
		files = append(files, f)
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Label < dirs[j].Label })
	sort.Slice(files, func(i, j int) bool { return files[i].Label < files[j].Label })
	// Directories first: you are almost always navigating, not reading.
	return append(dirs, files...)
}

func errText(err error) string {
	if os.IsPermission(err) {
		return "permission denied"
	}
	return "unreadable"
}

// size renders a byte count in at most four characters, so the right column
// never shifts.
func size(b int64) string {
	switch {
	case b < 1000:
		return strconv.FormatInt(b, 10) + "b"
	case b < 1000*1000:
		return strconv.FormatInt((b+512)/1024, 10) + "k"
	case b < 1000*1000*1000:
		return strconv.FormatInt((b+512*1024)/(1024*1024), 10) + "m"
	default:
		return strconv.FormatInt((b+512*1024*1024)/(1024*1024*1024), 10) + "g"
	}
}
