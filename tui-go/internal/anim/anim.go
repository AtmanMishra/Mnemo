// Package anim is the interface's motion: springs for the transitions the eye
// should follow, a bounded pulse for the thinking indicator, and the one switch
// that turns all of it off.
//
// Nothing in here reads the clock, and nothing in here decides when a frame is
// drawn. Both of those are the point.
//
// # The question this package exists to answer
//
// An animation that never finishes is a redraw that never stops. The interface
// already treats a spinner nobody stops as a bug (app/update.go: "a spinner
// nobody stops is a UI that looks hung") and only ticks while the agent is
// working, because a TUI that animates while nothing happens is burning a
// battery to look busy (app/model.go, tickMsg). An animation added carelessly
// undoes that: one spring that forgets to settle and the screen ticks forever,
// which is invisible on the developer's machine and a fan spinning on a laptop.
//
// So motion here cannot be opted into by accident. Every spring belongs to a
// Group, the group advances them together, and the app asks the group one
// question — "do I need another frame?" — and nothing else:
//
//	// the model holds the group and the springs it draws
//	m.motion = anim.NewGroup(anim.Frame)
//	m.slide = m.motion.New(anim.Soft, 0) // an overlay, off screen
//
//	// when the overlay opens, say where it should be
//	m.slide.To(1)
//
//	// on every frame
//	m.motion.Tick()
//
//	// and schedule the next frame only while something is still moving
//	if m.motion.Animating() {
//		cmds = append(cmds, tickCmd())
//	}
//
// There is deliberately no way to advance a spring on its own and no way to ask
// about one individually: the moment a call site inspects springs one by one,
// the next animation added is one that call site forgets.
//
// A pulse is not a spring and cannot join a group. It oscillates for exactly as
// long as the work it indicates is running, so it never settles and could never
// answer the question honestly; its reason for a frame is the work itself,
// which the app already tracks because the work is what turns the spinner. It
// rides that condition instead of asking for one.
//
// # Rest is exact
//
// A spring within Epsilon of its target, moving slower than VelocityEpsilon, is
// at rest — and at rest means pinned to the target exactly. A settled value is
// therefore bit-identical from frame to frame: ticking a rested group any number
// of times does not move it, so a still screen stays still even if some future
// bug schedules frames for it.
//
// # Turning it off
//
// Terminals record (script(1), asciinema, the golden-frame harness) and people
// use screen readers and reduced-motion settings they cannot express to a TUI.
// MNEMO_NO_ANIMATION=1 — or Off(), or SetEnabled(false) — makes every value where
// it was told to be.
//
// Set while nothing is moving, which is how it is actually used (a start-up
// environment), a value is final the moment it is set: Animating says false and
// no frame is spent on it. Flipped while a spring is in the air, the frame that
// lands it is the last one — the screen is final one frame after the switch is,
// rather than frozen half way up it.
//
// Motion is on unless something that reads as yes says otherwise: a preference is
// not worth an error dialog, so "0", an empty value and a typo all mean "leave it
// on".
package anim

import (
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// Frame is the cadence a spring is built for when a caller does not name one:
// 60 frames a second, which is as smooth as a terminal can usefully be redrawn.
//
// The interface's own tick is coarser than this (theme.SpinnerIntervalMS), and
// that is not a problem. Harmonica solves the spring analytically, so a spring
// built for 80ms ticks comes to rest in the same wall-clock time as one built
// built for 16ms — the same trajectory, sampled less often. Every preset's
// settle budget is asserted at every cadence the tests use, spring_test.go.
const Frame = 16 * time.Millisecond

// What this package means by "settled": within Epsilon of the target and moving
// slower than VelocityEpsilon.
//
// The numbers are the contract rather than taste. A value is a fraction of
// whatever the app scales it by — a panel's rows, a block's intensity — so
// Epsilon is a thousandth of that, well under one cell; a velocity of 0.05 per
// second moves a thousandth of a cell in a frame. Both are far below what a
// terminal can draw, which is what lets a settled spring be pinned exactly
// instead of creeping toward its target for the rest of the session.
const (
	Epsilon         = 1e-3
	VelocityEpsilon = 5e-2
)

// EnvNoAnimation is how a person or a script says "not this terminal". Set it
// to a value that reads as yes — 1, true, yes, on — and every value in this
// package is where it was told to be, one frame after it was told.
//
// It is an environment variable rather than a limits.json key for the same
// reason MNEMO_MOUSE is: reduced motion is a property of this terminal and this
// recording session, not of this machine's saved preferences. `script`,
// asciinema and the golden-frame harness all run the interface somewhere a
// spring mid-flight is a frame nobody asked for, and a screen reader's user has
// asked for no motion at all.
const EnvNoAnimation = "MNEMO_NO_ANIMATION"

// motion is the process-wide switch. Atomic because the render path reads it on
// every frame while the app's own goroutine is free to change it.
var motion atomic.Bool

func init() { applyEnv(os.Getenv) }

// Enabled reports whether motion is on.
func Enabled() bool { return motion.Load() }

// SetEnabled turns motion on or off for the process.
//
// Turning it off is not a pause: from the next question onwards every value is
// at its target, so the screen is final rather than frozen half way. Turning it
// back on replays nothing — the springs are already where they should be, and
// the next To is what moves them.
func SetEnabled(on bool) { motion.Store(on) }

// Off turns motion off, the state MNEMO_NO_ANIMATION=1 starts the process in.
func Off() { SetEnabled(false) }

// applyEnv is what start-up does, and is callable again for a caller that has
// just set the variable. getenv is a parameter for the same reason it is in
// internal/limits: the environment is the test harness's, not this package's.
func applyEnv(getenv func(string) string) { SetEnabled(fromEnv(getenv)) }

// fromEnv reads the environment's answer.
func fromEnv(getenv func(string) string) bool { return !truthy(getenv(EnvNoAnimation)) }

// truthy is the yes this package accepts, and everything else is a no: anything
// that does not read as an affirmative — unset, empty, "0", "false", a typo —
// leaves motion on rather than silently stopping it.
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "t", "true", "y", "yes", "on":
		return true
	}
	return false
}
