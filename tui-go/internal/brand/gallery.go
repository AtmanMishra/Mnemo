package brand

import (
	_ "embed"
	"fmt"
	"image/color"
	"reflect"
	"strings"
	"text/template"

	"github.com/AtmanMishra/self-evolving-agent/tui-go/internal/theme"
	"github.com/charmbracelet/x/ansi"
)

// The docs are generated, not written.
//
// The page and the chart beside it carry values — palette hexes, glyphs, code
// points, art — that exist to be looked at. Written by hand they were a copy,
// and a copy of a preview is wrong within a day and wrong in the way that reads
// as authoritative. So both are rendered from the live values here, and
// TestDocsAreGeneratedFromTheSource fails when the file on disk and the source
// disagree — the same contract app/testdata/golden has, for the same reason.
//
// preview.tmpl.html holds the prose and the layout; every value in it arrives
// through the data below. Edit prose there, edit colours and art in theme.go and
// brand.go, then regenerate:
//
//	cd tui-go && go test ./internal/brand/ -run Docs -update-docs

//go:embed preview.tmpl.html
var previewTemplate string

// Doc is one generated file: where it lives, relative to the repository root,
// and what it should contain.
type Doc struct {
	Path string
	Body string
}

// Docs is every generated document.
func Docs() []Doc {
	return []Doc{
		{"docs/design-preview.html", PreviewHTML()},
		{"docs/mascots.md", MascotsMarkdown()},
	}
}

// paletteRoles is the fourteen, in the order the interface reads them.
// Declared here as (name, colour) so the docs page can emit CSS custom
// properties and the swatch list from one walk.
func paletteRoles(p theme.Palette) [][2]string {
	return [][2]string{
		{"ground", hex(p.Ground)},
		{"ink", hex(p.Ink)},
		{"muted", hex(p.Muted)},
		{"faint", hex(p.Faint)},
		{"accent", hex(p.Accent)},
		{"thinking", hex(p.Thinking)},
		{"coat", hex(p.Coat)},
		{"rosette", hex(p.Rosette)},
		{"peach", hex(p.Peach)},
		{"ok", hex(p.OK)},
		{"fail", hex(p.Fail)},
		{"warn", hex(p.Warn)},
		{"link", hex(p.Link)},
		{"deep", hex(p.Deep)},
	}
}

// means is what each role is for, in the page's own words. It is prose, so it
// lives with the generator rather than in the theme — the theme's job is the
// fourteen values, not the sentence that explains them.
var means = map[string]string{
	"ground":   "the page itself — nothing may sit on it that is not a role",
	"ink":      "body text; the agent's voice",
	"muted":    "de-emphasis, the rule, timestamps",
	"faint":    "inactive chrome, the user's own line background",
	"accent":   "you, and the one live thing on screen",
	"thinking": "reasoning, folded by default",
	"coat":     "the creatures' body",
	"rosette":  "detail tones, the wordmark lip, the header band",
	"peach":    "the one highlight: inner ear, wing, a thought forming",
	"ok":       "success, a tool that finished",
	"fail":     "failure",
	"warn":     "warning — and nothing else",
	"link":     "links, paths, commands",
	"deep":     "reserved",
}

// hex renders a palette colour as the hex string the page writes into CSS.
//
// Through RGBA() and not through fmt: a lipgloss colour is an interface, its
// concrete type is not printable, and printing it yields "{0 0 0 255}" — which
// is how a generated stylesheet ends up with a broken colour and nobody notices
// until it looks wrong in a browser. RGBA() is 16-bit, so each channel comes
// back by shifting, not by dividing.
func hex(c color.Color) string {
	r, g, b, _ := c.RGBA()
	return fmt.Sprintf("#%02X%02X%02X", r>>8, g>>8, b>>8)
}

// glyphRowDocs is the page's glyph table: one line per field of theme.Glyphs,
// with the class that paints it and what the glyph is for.
//
// The width column is not here — that is theme's own contract, and the page
// reads it from the glyph. A test asserts this table covers exactly the fields
// the struct has, so a glyph added to the family cannot go undocumented.
var glyphRowDocs = []struct{ Field, Class, Means string }{
	{"User", "ac", "the gutter, you: a person — a head over a shoulder-line, in the accent because the accent is yours"},
	{"Agent", "co", "the gutter, the agent: a machine — the same mass as the person with a lid where the head would be"},
	{"Think", "th", "the gutter, reasoning: a thought — the lower pixel only, the one gutter that is not solid, because it is not finished"},
	{"Tool", "g", "the gutter, a tool call: solid, and the row that carries state (ok / fail / running)"},
	{"Closed", "g", "folded shut: click or enter to open. The block range has no arrowhead, so a direction is a triangle"},
	{"Open", "g", "open"},
	{"Branch", "g", "a tree's branch point — the elbow IS the drawing"},
	{"Last", "g", "the last child: the one elbow that closes the trunk"},
	{"Pipe", "g", "the tree's continuing trunk"},
	{"Gap", "g", "no child here"},
	{"H", "g", "the loud rule: a region's whole width, drawn at the top pixel — half a cell of solid ink reads as a bar, not as a hairline"},
	{"Hair", "g", "the quiet rule: the header at rest, and any rule too narrow to carry a label"},
	{"V", "g", "a column divider or a panel's side — a hairline, never a half block, because a half-block divider eats a direction"},
	{"Nub", "g", "the label notch: the rule steps down and the label sits in the slot it makes; its mirror closes the other side"},
	{"Seg", "g", "a band's divider, and the marker on the focused row: half a cell of ink separates without spending a column of air"},
	{"Tick", "ba", "the header's stamp: the one quadrant block, so the brand mark is the same material at a finer grain"},
}

// figureDoc is the gutter table: the same four fields, described as figures.
//
// Each entry says what the two pixels of the figure are doing, because that is
// the whole design: a shape has to say who is speaking to a reader who has not
// learned the palette, and every figure ends half-empty on the right so the
// prose never butts against a wall.
var figureDoc = []struct{ Field, Why string }{
	{"User", "a head, then a shoulder-line under it — the only figure whose first cell is solid top to bottom, which is what makes it read as a person rather than as a bar"},
	{"Agent", "the same mass as the person with no head on it: a walled slab. One pixel is the difference between a speaker and the interface, and that is all it needs to be"},
	{"Think", "the ramp's lightest step over a low pixel. Thinking is the one thing that is not finished, so its figure is the one figure that is not solid — and it is made of the same dither the thinking band is"},
	{"Tool", "an upright held in air: two half-cells with air either side, the narrowest mark in the set. A tool call is the row that carries state, and the state has its own colour"},
}

// pixelName says what a cell of a half-block figure is made of, so the table on
// the page is read out of the glyph rather than described beside it.
var pixelName = map[rune]string{
	' ': "empty",
	'█': "both pixels",
	'▀': "the top pixel",
	'▄': "the bottom pixel",
}

// figureParts describes a two-cell figure cell by cell.
func figureParts(g string) string {
	var parts []string
	for _, r := range g {
		if n, ok := pixelName[r]; ok {
			parts = append(parts, n)
			continue
		}
		parts = append(parts, fmt.Sprintf("%q", r))
	}
	return strings.Join(parts, " + ")
}

// classForRole maps an art role to the page's colour class. A marker with no
// role is a hole and is drawn as nothing, which is the whole point of a hole.
func classForRole(role string) string {
	switch role {
	case "coat":
		return "mcoat"
	case "detail":
		return "mros"
	case "highlight":
		return "mpeach"
	case "accent":
		return "macc"
	}
	return "mhole"
}

// artHTML renders marker art at the size the terminal draws it, one span per
// run of markers. Runs are grouped by role for the same reason Paint groups
// them: the spans are what a reader sees in the source, and a span per mark
// would be thirty times the markup for the same picture.
func artHTML(art []string, scale int) string {
	var b strings.Builder
	for i, row := range art {
		if i > 0 {
			b.WriteString("\n")
		}
		var run strings.Builder
		var cur string
		started := false
		flush := func() {
			if !started {
				return
			}
			if cur == "" {
				b.WriteString(run.String())
			} else {
				fmt.Fprintf(&b, `<span class="%s">%s</span>`, cur, run.String())
			}
			run.Reset()
		}
		for _, m := range row {
			p, ok := byMarker[m]
			cls := "mhole"
			glyph := " "
			if ok {
				cls = classForRole(p.Role)
				glyph = p.Wide
				if scale == 1 {
					glyph = p.Narrow
				}
			} else {
				cls = "" // '.' and anything unknown: nothing at all
				glyph = strings.Repeat(" ", scale)
			}
			if started && cls != cur {
				flush()
			}
			cur, started = cls, true
			run.WriteString(glyph)
		}
		flush()
	}
	return b.String()
}

// previewData is everything the page's template can reach. Every field is
// either a live value or markup built from one.
type previewData struct {
	Vars               string
	PresetButtons      string
	Swatches           string
	GlyphRows          string
	GutterRows         string
	Gallery            string
	Wordmark           string
	Waves              string
	JS                 string
	Spinner            string
	Tagline            string
	CreatureNames      string
	WordmarkWidth      int
	WordmarkSmallWidth int
	WavePhases         int
	WaveWidth          int
	G                  theme.Glyphs
}

// PreviewHTML renders docs/design-preview.html from the live values.
func PreviewHTML() string {
	// The shipping palette and the shipping set: this page is a picture of what
	// a fresh install looks like, so it reads both by name rather than assuming.
	p, ok := theme.ByName(theme.Shipping)
	if !ok {
		panic("brand: the shipping palette is not in the picker's list")
	}
	t := theme.New(p, theme.Heavy, true)
	d := previewData{
		Vars:               varCSS(p),
		PresetButtons:      presetButtons(),
		Swatches:           swatches(p),
		GlyphRows:          glyphRows(),
		GutterRows:         gutterRows(),
		Gallery:            gallery(),
		Wordmark:           artHTML(Wordmark, ScaleWordmark),
		Waves:              waves(),
		JS:                 pageJS(),
		Spinner:            theme.Spinner[0],
		Tagline:            Tagline,
		CreatureNames:      creatureNames(),
		WordmarkWidth:      Width(Wordmark, ScaleWordmark),
		WordmarkSmallWidth: Width(WordmarkSmall, ScaleWordmark),
		WavePhases:         8,
		WaveWidth:          28,
		G:                  t.G,
	}
	funcs := template.FuncMap{
		// rep exists so the mock transcript can draw a rule of the real glyph
		// for a real width without a hundred literal characters in the
		// template that nobody would notice going stale. Count first, because
		// `rep 78 .G.Tick` reads as a rule of 78 cells.
		"rep": func(n int, s string) string { return strings.Repeat(s, n) },
	}
	tmpl := template.Must(template.New("preview").Delims("<%", "%>").Funcs(funcs).Parse(previewTemplate))
	var b strings.Builder
	if err := tmpl.Execute(&b, d); err != nil {
		// A template that cannot render is a build-time bug, not a runtime
		// condition: the page is generated by a test, and the test must fail.
		panic(fmt.Sprintf("brand: rendering the preview template: %v", err))
	}
	return b.String()
}

// varCSS is the page's own ground plus the fourteen roles.
//
// --page and --card are the PAGE's surfaces and are written as var() references
// to roles rather than as new hexes: the theme is the only place a colour is
// named, and a preview with private colours is a preview that lies about the
// palette.
func varCSS(p theme.Palette) string {
	var b strings.Builder
	for _, r := range paletteRoles(p) {
		fmt.Fprintf(&b, "\n    --%s: %s;", r[0], r[1])
	}
	b.WriteString("\n    --page: var(--ground); --card: var(--faint); --line: var(--faint); --dim: var(--muted);\n  ")
	return b.String()
}

// presetButtons is one button per palette the picker offers, shipping first and
// marked as in force — the same order and the same first row the picker shows.
func presetButtons() string {
	var b strings.Builder
	for i, pre := range theme.Presets() {
		label := pre.Name
		class := ""
		if i == 0 {
			label += " (shipping)"
			class = ` class="on"`
		}
		fmt.Fprintf(&b, `<button onclick="preset('%s')" id="b-%s"%s title="%s">%s</button>`,
			pre.Name, pre.Name, class, pre.Desc, label)
	}
	return b.String()
}

// swatches is the palette table: chip, role, what it is for, hex, and a colour
// box that repaints the page live.
func swatches(p theme.Palette) string {
	var b strings.Builder
	for _, r := range paletteRoles(p) {
		role, value := r[0], r[1]
		fmt.Fprintf(&b, `<div class="sw"><span class="chip" style="background:%s"></span>`+
			`<span><span class="role">--%s</span> <span class="hex">· %s</span></span>`+
			`<span class="hex" id="hex-%s" style="margin-left:auto">%s</span>`+
			`<input type="color" value="%s" oninput="setRole('%s',this.value)"></div>`,
			value, role, means[role], role, strings.ToUpper(value), value, role)
	}
	return b.String()
}

// glyphRows is the glyph table's body, in the family's own reading order.
func glyphRows() string {
	var b strings.Builder
	for _, d := range glyphRowDocs {
		g := reflectField(d.Field)
		fmt.Fprintf(&b, "\n      <tr><td>%s</td><td class=\"gl %s\">%s</td><td>%d</td><td>%s</td></tr>",
			strings.ToLower(d.Field), d.Class, g, ansi.StringWidth(g), d.Means)
	}
	return b.String()
}

// gutterRows is the four speaker figures, drawn at real size.
func gutterRows() string {
	var b strings.Builder
	for _, d := range figureDoc {
		g := reflectField(d.Field)
		fmt.Fprintf(&b, "\n      <tr><td>%s</td><td class=\"gl ac\">%s</td><td>%s</td><td>%s</td></tr>",
			strings.ToLower(d.Field), g, figureParts(g), d.Why)
	}
	return b.String()
}

// gallery is one card per creature, with every pose it wears at the size the
// terminal draws it.
func gallery() string {
	var b strings.Builder
	for _, c := range Creatures {
		ship := ""
		if c.Name == Shipping.Name {
			ship = ` <span class="hex">· the one that ships</span>`
		}
		fmt.Fprintf(&b, "\n    <div class=\"mascot\"><h4>%s%s</h4><div class=\"ep\">%s</div><div class=\"poses\">",
			c.Name, ship, c.Ep)
		for _, p := range c.Poses() {
			fmt.Fprintf(&b, "\n      <div class=\"pose\"><div class=\"pn\">%s</div>"+
				"<pre class=\"art\">%s</pre><div class=\"pw\">%s</div></div>",
				p.Name, artHTML(p.Art, ScaleMascot), p.Why)
		}
		b.WriteString("\n    </div></div>")
	}
	return b.String()
}

func creatureNames() string {
	names := make([]string, 0, len(Creatures))
	for _, c := range Creatures {
		names = append(names, c.Name)
	}
	return strings.Join(names, ", ")
}

// waves is the thinking band, one line per phase, from theme.Wave — the same
// function the interface animates with, not a second implementation in
// JavaScript that could disagree with it.
func waves() string {
	var b strings.Builder
	for phase := 0; phase < 8; phase++ {
		if phase > 0 {
			b.WriteString("\n")
		}
		b.WriteString(theme.Wave(phase, 28))
	}
	return b.String()
}

// pageJS is the page's only behaviour: switch presets, retitle a swatch.
//
// Generated rather than written into the template because the preset values are
// the theme's, and a JavaScript copy of fourteen hexes per preset is exactly the
// copy that goes stale.
func pageJS() string {
	var b strings.Builder
	b.WriteString("// generated from theme.Presets() — do not edit here, edit theme.go\nconst PRESETS = {\n")
	for _, pre := range theme.Presets() {
		b.WriteString("  " + pre.Name + ": {")
		for i, r := range paletteRoles(pre.P) {
			if i > 0 {
				b.WriteString(",")
			}
			fmt.Fprintf(&b, "%s:'%s'", r[0], r[1])
		}
		b.WriteString("},\n")
	}
	b.WriteString("};\nconst ROLES = [")
	for i, r := range paletteRoles(theme.PICO8) {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, "'%s'", r[0])
	}
	b.WriteString("];\n")
	b.WriteString(`function setRole(role, value){
  document.documentElement.style.setProperty('--'+role, value);
  const el = document.getElementById('hex-'+role);
  if (el) el.textContent = value.toUpperCase();
}
function preset(name){
  const p = PRESETS[name];
  if (!p) return;
  Object.entries(p).forEach(([role, value]) => setRole(role, value));
  document.querySelectorAll('.toolbar button').forEach(b => b.classList.remove('on'));
  const btn = document.getElementById('b-'+name);
  if (btn) btn.classList.add('on');
}`)
	return b.String()
}

// MascotsMarkdown renders docs/mascots.md: the creatures, their poses, the art
// as you would edit it, and the rules the next one has to keep.
func MascotsMarkdown() string {
	var b strings.Builder
	b.WriteString("<!-- GENERATED FILE — do not edit by hand.\n" +
		"     Rendered from tui-go/internal/brand/brand.go by MascotsMarkdown().\n" +
		"     Regenerate: cd tui-go && go test ./internal/brand/ -run Docs -update-docs\n" +
		"     The same test fails when this file and the source disagree. -->\n\n")
	b.WriteString("# The creatures\n\n")
	fmt.Fprintf(&b, "Three figures, %d marks by %d rows each, drawn at %d cells to a mark — a "+
		"%d-cell-wide, %d-pixel-tall sprite, because a terminal cell is two pixels tall.\n\n",
		len(Karkinos.Idle[0]), len(Karkinos.Idle), ScaleMascot,
		Width(Karkinos.Idle, ScaleMascot), 2*len(Karkinos.Idle))
	b.WriteString("They replaced a Bengal cat: 20 rows × 28 marks, four tones, a spotted belly, a ringed " +
		"tail and a walk cycle in four frames — three of which differ only in the legs. Beautiful, " +
		"and nobody could change it. A figure here is twenty-five marks, so it is redrawable by " +
		"reading the source for half a minute.\n\n")
	fmt.Fprintf(&b, "The one that ships on the welcome screen is **%s**. `brand.Frame(tick)` animates it; "+
		"`brand.ByName(name)` gets any of them.\n\n", Shipping.Name)

	// The marker table first: the art below is unreadable without it.
	b.WriteString("## The markers\n\n")
	b.WriteString("Art is stored as markers, never as coloured spans: the shape and the palette stay one " +
		"thing each, and one table turns a marker into a glyph, a colour and a role — which is also " +
		"what the docs page reads, so the two cannot disagree.\n\n")
	b.WriteString("| marker | role | drawn at " + fmt.Sprint(ScaleMascot) + " cells | at 1 cell | meaning |\n|---|---|---|---|---|\n")
	for _, p := range Pixels {
		role := p.Role
		if role == "" {
			role = "—"
		}
		b.WriteString("| `" + string(p.Marker) + "` | " + role + " | `" + p.Wide + "` | `" + p.Narrow + "` | " + markerMeans(p) + " |\n")
	}
	b.WriteString("| `.` | — | `  ` | ` ` | nothing here — the art's own blank |\n\n")

	// One section per creature.
	for _, c := range Creatures {
		fmt.Fprintf(&b, "## %s — %s\n\n", c.Name, shortName(c))
		if c.Name == Shipping.Name {
			b.WriteString("*this is the one that ships*\n\n")
		}
		b.WriteString(c.Ep + "\n\n")
		b.WriteString("```\n")
		b.WriteString(poseColumns(c))
		b.WriteString("```\n\n")
		for _, p := range c.Poses() {
			fmt.Fprintf(&b, "- **%s** — %s\n", p.Name, p.Why)
		}
		b.WriteString("\nSource (this is the editable form; the drawing above is what it compiles to):\n\n")
		for _, p := range c.Poses() {
			note := "# " + p.Name
			if p.Name == "blink" {
				note += " (derived — Blink(idle) fills the eye holes; edit the body, not this)"
			}
			fmt.Fprintf(&b, "```\n%s\n%s\n```\n\n", note, strings.Join(p.Art, "\n"))
		}
	}
	return b.String()
}

// markerMeans is the one-line meaning of a marker, kept beside the marker table
// rather than inside Pixel: Pixel is art, and a sentence is not.
func markerMeans(p Pixel) string {
	switch p.Marker {
	case '#':
		return "the body"
	case 'u':
		return "the body's upper pixel — a raised limb, a wing up"
	case 'v':
		return "the body's lower pixel — a thin leg, a claw held low"
	case 'r':
		return "detail, light"
	case 'R':
		return "detail, heavy — a stripe"
	case 'e':
		return "the wordmark's lip"
	case 'p':
		return "the one highlight: inner ear, wing, a thought forming"
	case 'n':
		return "THE accent — exactly one run per frame"
	case 'O':
		return "an eye: a hole in the body, never a drawn shape"
	case '_':
		return "what a blink fills the hole with"
	}
	return ""
}

// shortName is the creature's name with the article it is described by, for the
// section heading: the epithet's first clause.
//
// Sliced by the byte length of the separator rather than by a guessed 3: " — "
// is a space, a three-byte em dash and a space, and taking three bytes of it
// leaves half a character in the heading.
func shortName(c Creature) string {
	const sep = " — "
	ep := c.Ep
	if i := strings.Index(ep, sep); i >= 0 {
		ep = ep[i+len(sep):]
	}
	if i := strings.IndexAny(ep, ".,"); i > 0 {
		ep = ep[:i]
	}
	return ep
}

// poseColumns draws every pose of a creature side by side, one character per
// mark. The terminal draws each mark as two cells; at one cell the art is the
// size of the data you actually edit, which is what this table is for.
//
// Widths are measured in CELLS (ansi.StringWidth) and never in bytes: one mark
// here is a three-byte rune in a file and one cell on a screen, and padding by
// byte count is how a doc ends up with a staircase in it.
func poseColumns(c Creature) string {
	poses := c.Poses()
	cols := make([][]string, len(poses))
	widths := make([]int, len(poses))
	for i, p := range poses {
		cols[i] = PaintText(p.Art, 1)
		widths[i] = 0
		for _, row := range cols[i] {
			if w := ansi.StringWidth(row); w > widths[i] {
				widths[i] = w
			}
		}
	}
	var titles, gaps strings.Builder
	for i, p := range poses {
		if i > 0 {
			titles.WriteString("  ")
			gaps.WriteString("  ")
		}
		titles.WriteString(pad(p.Name, widths[i]))
		gaps.WriteString(strings.Repeat("-", widths[i]))
	}
	var b strings.Builder
	b.WriteString(strings.TrimRight(titles.String(), " ") + "\n")
	b.WriteString(gaps.String() + "\n")
	for row := range cols[0] {
		var line strings.Builder
		for i := range cols {
			if i > 0 {
				line.WriteString("  ")
			}
			line.WriteString(cols[i][row])
		}
		b.WriteString(strings.TrimRight(line.String(), " ") + "\n")
	}
	return b.String()
}

func pad(s string, n int) string {
	if w := ansi.StringWidth(s); w < n {
		return s + strings.Repeat(" ", n-w)
	}
	return s
}

// PaintText renders marker art with no styling at all, for a document: the
// characters are the picture, and ANSI escapes in a markdown file are noise.
func PaintText(art []string, scale int) []string {
	var out []string
	for _, row := range art {
		var b strings.Builder
		for _, m := range row {
			p, ok := byMarker[m]
			if !ok {
				b.WriteString(strings.Repeat(" ", scale))
				continue
			}
			if scale == 1 {
				b.WriteString(p.Narrow)
			} else {
				b.WriteString(p.Wide)
			}
		}
		out = append(out, b.String())
	}
	return out
}

// reflectField reads one glyph out of the shipping set by name.
//
// A lookup rather than a switch: the doc tables are checked against the struct
// by a test, and a switch here would be a second place to forget that a field
// exists. A name that is not a field of theme.Glyphs panics, which is a
// build-time failure of the generator — the right failure for a doc table that
// has drifted from the set it documents.
func reflectField(name string) string {
	return reflect.ValueOf(theme.Heavy).FieldByName(name).String()
}
