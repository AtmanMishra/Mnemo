package anim

import (
	"math"
	"time"

	// Harmonica is required under its github path, not charm.land/harmonica.
	// The proxy does serve a charm.land/harmonica v0.2.0, but that zip's go.mod
	// declares github.com/charmbracelet/harmonica, and the toolchain refuses
	// the mismatch ("module declares its path as ... but was required as ...").
	// Same code, same v0.2.0 tag; this is the only spelling Go accepts.
	"github.com/charmbracelet/harmonica"
)

// Preset is the feel of a spring, in the two numbers a damped oscillator is
// made of: an angular frequency (how fast it moves, in radians per second) and
// a damping ratio (how much it settles — 1.0 is critically damped, the fastest
// approach that does not overshoot).
//
// The three presets are the three transitions this interface actually has, and
// their numbers were measured rather than guessed: all three come to rest inside
// 800ms at every tick interval the interface might use, which is what keeps them
// inside the still-screen rule. spring_test.go fails if that stops being true.
//
// The zero Preset has no stiffness, and a spring that cannot move is not a
// spring: it is at its target from the first frame and never asks for one.
// Anything else would be a value that animates forever on a screen that is not
// changing.
type Preset struct {
	name string
	w    float64
	z    float64
}

// String names the preset, for a log line or a test failure.
func (p Preset) String() string { return p.name }

var (
	// Snappy is for a block appearing — a tool result unfolding, a row arriving
	// in the transcript. Critically damped on purpose: text that overshoots and
	// settles back is text that wobbles, and a wobbling line of prose reads as
	// a rendering fault rather than as motion. At rest in about 430ms.
	Snappy = Preset{name: "snappy", w: 22, z: 1}

	// Soft is for a modal sliding in. It is allowed a deliberate 1.5%
	// overshoot, so the panel reads as coming to rest rather than being
	// switched on — motion the eye can finish, which is the difference between
	// a modal and a page. At rest in about 780ms.
	Soft = Preset{name: "soft", w: 11, z: 0.8}

	// Slow is slow enough to read, which is what repeated motion has to be. It
	// shapes the thinking pulse (Pulse), where anything quicker is a flicker
	// rather than a breath, and it is the preset for a value the reader is meant
	// to follow rather than merely notice. At rest in about 780ms.
	Slow = Preset{name: "slow", w: 12, z: 1}
)

// Spring is one animated number: the app says where it should be, the group ticks
// it, and the app reads where it is.
//
// The tick interval is a parameter of the spring, and the physics coefficients
// are computed from it, so a spring's trajectory is a function of its tick count
// and nothing else. Nothing here reads the clock, which is what lets a test
// advance a spring to its rest position in a loop and assert it converges — and
// what makes two machines that run the same frames draw the same frames.
//
// A Spring is not safe for concurrent use: it is advanced from one goroutine, the
// same one that owns the rest of the app's model.
type Spring struct {
	tick   time.Duration
	preset Preset
	spring harmonica.Spring

	pos, vel float64
	target   float64
}

// To says where the spring should be. It keeps its position and velocity while
// it travels, so retargeting a moving spring carries its momentum instead of
// snapping it to the new journey's start.
//
// Asking for where it already is is not motion: a view that recomputes its
// targets every frame must not restart a spring, or the screen never stops.
func (s *Spring) To(target float64) {
	s.target = target
	s.land()
}

// Snap puts the spring at a value with no motion at all, which is how a screen's
// first frame is final: a panel that is already open when the frame is drawn must
// not slide in from wherever a previous layout left it.
func (s *Spring) Snap(at float64) {
	s.pos, s.vel, s.target = at, 0, at
}

// Value is where the spring is now.
func (s *Spring) Value() float64 { return s.pos }

// Target is where the spring was last told to go.
func (s *Spring) Target() float64 { return s.target }

// Settled reports whether the spring has arrived and stopped: within Epsilon of
// its target and moving slower than VelocityEpsilon. A settled spring is pinned
// to its target exactly, so its value cannot creep if the screen keeps being
// redrawn.
func (s *Spring) Settled() bool {
	return math.Abs(s.pos-s.target) <= Epsilon && math.Abs(s.vel) <= VelocityEpsilon
}

// Animating reports whether the spring still has somewhere to go.
func (s *Spring) Animating() bool { return !s.Settled() }

// noMotion reports whether this spring has no motion to make: motion is off for
// the process, or the preset has no stiffness.
func (s *Spring) noMotion() bool { return !Enabled() || s.preset.w <= 0 }

// land puts a spring that has no motion to make at its target, in fact rather
// than only in appearance: with motion off, Value must BE the target, because
// there is no frame coming to finish a journey nobody can see the middle of.
//
// It is called from the two places the state can change — a new target, and a
// frame — so nothing has to know about it. A getter that changed a value would
// be a surprise; a setter that leaves a spring on its way somewhere is worse.
func (s *Spring) land() {
	if !s.noMotion() {
		return
	}
	s.pos, s.vel = s.target, 0
}

// advance moves the spring one frame.
//
// It is unexported because a spring is advanced by its group: one spring advanced
// at a call site is a spring the neighbouring call site forgets, and that is the
// always-on redraw this package exists to prevent. Use Group.Tick.
func (s *Spring) advance() {
	if s.noMotion() {
		s.land()
		return
	}
	pos, vel := s.spring.Update(s.pos, s.vel, s.target)
	if math.Abs(pos-s.target) <= Epsilon && math.Abs(vel) <= VelocityEpsilon {
		// At rest, pinned: the last thousandth is invisible, and pinning it makes
		// rest a fixed point rather than a slow creep that costs a frame every
		// 16ms for the rest of the session.
		s.pos, s.vel = s.target, 0
		return
	}
	s.pos, s.vel = pos, vel
}
