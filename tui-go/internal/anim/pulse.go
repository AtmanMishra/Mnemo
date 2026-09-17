package anim

import (
	"time"

	"github.com/charmbracelet/harmonica"
)

// PulsePeriod is how long one breath of the thinking indicator takes. Long
// enough to read as breathing rather than flickering, short enough that a
// glance at the screen sees it move.
const PulsePeriod = 1200 * time.Millisecond

// Pulse is the thinking indicator: one oscillation from dark to lit and back,
// repeated for as long as the work lasts.
//
// The shape is Slow's: a critically damped spring driven by a square wave that
// flips at the half period, so each breath leaves the dark end, nearly reaches
// the lit one, and comes back. Nothing here is a hand-drawn curve — the feel of
// the pulse is the same physics as the feel of an overlay sliding in, which is
// the reason there is a preset for it rather than a second set of numbers.
//
// A pulse is not a Spring and cannot join a Group. A spring exists to arrive, and
// its whole contract is Settled — a pulse never arrives, so a group holding one
// would report Animating forever and the screen would redraw for the rest of the
// session, which is the exact bug this package exists to prevent. Instead the
// pulse's reason for a frame is the work itself: the same condition that turns
// the spinner, and one the app already tracks. Run it while the agent is
// working, stop when it is done.
//
// Three properties are the contract, and pulse_test.go holds the package to all
// three:
//
//   - Bounded. The value stays inside [0,1] — it is an intensity, and one that
//     leaves its range is a glitch in whatever it paints. It is bounded because
//     the drive only ever asks for 0 or 1 and a critically damped spring never
//     passes a target it has reached; the test checks every frame of six periods
//     at three cadences rather than trusting that argument.
//   - Periodic. A period is a whole, even number of ticks, so a breath covers
//     exactly the same frames as the last one and the pulse does not beat
//     against the frame rate.
//   - Undrifted. Successive periods repeat to the bit (a relative difference
//     under 1e-9). A pulse that drifts is a distraction: the eye finds the
//     seam.
type Pulse struct {
	tick   time.Duration
	spring harmonica.Spring

	// halfTicks is half a period in frames — the point at which the drive flips.
	halfTicks int
	period    time.Duration

	ticks    int
	pos, vel float64
}

// NewPulse makes a pulse that advances by tick and breathes for period. A period
// of zero means PulsePeriod, and a tick of zero or less means Frame.
//
// The period is snapped to a whole, even number of ticks. A half period that
// lands between two frames is not a period: the drive would run 37 frames one
// way and 38 back, and the pulse would slip a frame per breath against its own
// beat. Snapped, the sequence repeats exactly. A requested period shorter than
// two frames becomes two frames; it is still bounded and still periodic, but the
// spring is given less time than it needs to travel, so such a pulse shimmers
// near the lit end instead of breathing to the dark one.
func NewPulse(tick, period time.Duration) *Pulse {
	if tick <= 0 {
		tick = Frame
	}
	if period <= 0 {
		period = PulsePeriod
	}
	half := int((period/2 + tick/2) / tick) // nearest whole frame, half up
	if half < 1 {
		half = 1
	}
	return &Pulse{
		tick:      tick,
		spring:    harmonica.NewSpring(tick.Seconds(), Slow.w, Slow.z),
		halfTicks: half,
		period:    time.Duration(half) * 2 * tick,
	}
}

// Period is the period the pulse actually breathes at: what was asked for,
// snapped to whole frames.
func (p *Pulse) Period() time.Duration { return p.period }

// Tick advances the pulse one frame. The drive is a square wave read off the
// frame count, not the clock, so the same frames give the same breath on any
// machine.
func (p *Pulse) Tick() {
	if !Enabled() {
		p.pos, p.vel, p.ticks = 0, 0, 0
		return
	}
	target := 0.0
	if (p.ticks/p.halfTicks)%2 == 0 {
		target = 1
	}
	p.pos, p.vel = p.spring.Update(p.pos, p.vel, target)
	p.ticks++
}

// Value is where the pulse is, in [0,1]. With motion off it is 1 — fully lit,
// not dark and not a midpoint: an indicator has to say what it indicates, and
// the one reading that would be wrong during work is "nothing is happening".
// Only the motion is decoration.
func (p *Pulse) Value() float64 {
	if !Enabled() {
		return 1
	}
	return p.pos
}
