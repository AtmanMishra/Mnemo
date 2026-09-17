package anim

import (
	"time"

	"github.com/charmbracelet/harmonica"
)

// Group is the springs on one surface, held together so the app can ask about
// all of them at once.
//
// It is the answer to the failure this package was written to prevent. A spring
// the app holds directly is a spring the app has to remember to ask about, and
// the first animation whose author forgets is the one that makes the screen tick
// forever. Here there is nothing to forget: springs are made by the group, the
// group advances them all, and Animating is the only question anybody asks.
type Group struct {
	tick    time.Duration
	springs []*Spring
}

// NewGroup makes an empty group whose springs advance by tick. A tick of zero or
// less means Frame.
//
// Zero is worth the guard. Harmonica with a zero delta time computes
// coefficients of one: the value never changes, and a spring that never moves
// never settles — an always-on redraw wearing a different hat, one frame at a
// time.
func NewGroup(tick time.Duration) *Group {
	if tick <= 0 {
		tick = Frame
	}
	return &Group{tick: tick}
}

// Interval is the group's cadence: the wall-clock time one call to Tick stands
// for. It is what the app schedules its next frame with, so the springs and the
// frames that carry them cannot drift apart.
func (g *Group) Interval() time.Duration { return g.tick }

// New makes a spring at rest at `at`, built for the group's cadence, and adds it
// to the group.
//
// It starts at rest where it is put rather than at zero. A spring that started at
// zero would slide into place on the first frame of the program: motion nobody
// asked for, on a screen that was supposed to be still.
func (g *Group) New(p Preset, at float64) *Spring {
	s := &Spring{tick: g.tick, pos: at, target: at, preset: p}
	if p.w > 0 {
		// The delta time is the group's interval, never a clock reading: the
		// coefficients that come out of it are what make a spring's trajectory
		// a function of its tick count alone.
		s.spring = harmonica.NewSpring(g.tick.Seconds(), p.w, p.z)
	}
	g.springs = append(g.springs, s)
	return s
}

// Tick advances every spring in the group by one frame. With motion off it lands
// them instead: every value jumps to its target, so one frame after a change the
// screen is final and Animating is false.
func (g *Group) Tick() {
	for _, s := range g.springs {
		s.advance()
	}
}

// Animating is the whole question the app asks: do I need another frame?
//
// It is true while any spring in the group is unsettled — one spring still
// travelling is a frame, however many others have arrived — and false the moment
// they have all come to rest, which is when the app stops scheduling ticks and
// the screen goes still. With motion off it is false immediately, because every
// value is already where it belongs.
//
// Schedule a frame from this and nothing else:
//
//	if m.motion.Animating() {
//		cmds = append(cmds, tickCmd())
//	}
func (g *Group) Animating() bool {
	for _, s := range g.springs {
		if s.Animating() {
			return true
		}
	}
	return false
}
