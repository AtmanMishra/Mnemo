//! Mnemo's brand: the wordmark and Nyx, the Bengal cat.
//!
//! Art is stored as MARKER strings, never as pre-coloured spans, so the shape
//! and the palette stay one thing each. `paint()` is the only place a glyph
//! becomes a colour.
//!
//! | marker | is | drawn as |
//! |---|---|---|
//! | `#` | coat / letterform | `██` in COAT |
//! | `R` | rosette core | `▓▓` in ROSETTE |
//! | `r` | rosette edge | `▒▒` in ROSETTE |
//! | `n` | nose | `▄▄` in ACCENT |
//! | `e` | the wordmark's lip | `▒` in ROSETTE |
//! | `.` | nothing | a space |
//!
//! There are two scales. The mascot is drawn at **2 cells per marker**,
//! because a terminal cell is about twice as tall as it is wide and a
//! one-cell pixel makes a squashed cat. The wordmark is already stored at
//! cell resolution — its letterforms are three cells thick with a half-cell
//! lip, which is what gives them depth — so it is drawn at **1 cell per
//! marker**. `SCALE_MASCOT` and `SCALE_WORDMARK` name the two.
//!
//! ## Why a Bengal, and why it is drawn this way
//!
//! The Bengal's defining feature is the ROSETTE: a two-toned spot with a dark
//! ring and a lighter centre, clustered rather than evenly scattered (TICA's
//! standard prefers rosettes over single spots, and calls for "extreme"
//! contrast against the ground colour). A cluster of two-toned marks that
//! means something as a group and not individually is exactly what Mnemo's
//! memory graph is, which is why the mascot is this breed and not a
//! silhouette of any cat.
//!
//! The rosettes are drawn from `theme::DITHER` — the same density ramp as the
//! thinking animation. One vocabulary, used twice.
//!
//! The breed's other signatures are in here too: bold **mascara** lines
//! running back from the eyes, small ears with a wide base, a heavy muzzle,
//! and a thick ringed tail. The nose is the one ACCENT-coloured pixel in the
//! whole mascot — the brand colour is the cat's nose.
use crate::theme;
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

/// The mascot is stored as pixels; one pixel is two cells wide.
pub const SCALE_MASCOT: usize = 2;
/// The wordmark is stored at cell resolution already.
pub const SCALE_WORDMARK: usize = 1;

/// Golden Bengal ground colour.
pub const COAT: Color = theme::ORANGE;
/// Rosette ink. PICO-8 brown: dark enough for the "extreme contrast" the
/// breed standard asks for, without going to flat black.
pub const ROSETTE: Color = theme::BROWN;

/// Nyx sitting, tail curled — the full mascot, first run and the empty Chat
/// pane only.
///
/// Solid blocks carry the mass; box-drawing carries the detail that blocks
/// cannot hold at this size — whiskers, a mouth, an eye with a real shape.
/// That mix is the whole trick: pixels for the animal, ASCII for the face.
pub const CAT_SIT: &[&str] = &[
    "..##..........##............",
    ".#pp#........#pp#...........",
    "..################..........",
    ".##################.........",
    ".##R##OO####OO##R##.........",
    ".##################.........",
    "-########nn########-........",
    "..################..........",
    "...##############...........",
    "....############.......##...",
    "...##############.....##R#..",
    "..##r####R####r###....##r#..",
    "..##R####r####R###....##R#..",
    "..##r####R####r###....##r#..",
    "..##R####r####R###...##R##..",
    "..################...##r##..",
    "..################..##R##...",
    "...##############..##r###...",
    "...##############.######....",
    "...##.##..##.##...####......",
];
/// Nyx's head, for the welcome card. Seven rows is as small as the breed
/// markings survive: below this the mascara and the muzzle merge into a blob
/// and it stops being a Bengal.
pub const CAT_HEAD: &[&str] = &[
    "..##......##..",
    ".####....####.",
    ".############.",
    "##.##....##.##",
    "##############",
    ".####.nn.####.",
    "..##########..",
];

/// Three rows, for a cramped header. The mascara is gone; the ears and the
/// eyes are what still has to read.
pub const CAT_TINY: &[&str] = &[
    ".##....##.",
    ".########.",
    "##.####.##",
];

/// Nyx walking, seen from the side. Four frames: the legs gather, spread and
/// gather again, so the cycle loops without a jump.
///
/// A side view is not vanity — a cat walking towards you does not read as
/// walking. The tail is raised and ringed, which is the breed's tell and also
/// the only part with room to show rosettes at this size.
pub const WALK: [&[&str]; 4] = [&WALK_A, &WALK_B, &WALK_C, &WALK_B];

const WALK_BODY: [&str; 7] = [
    "..##.......##..##...",
    ".#rr#.....########..",
    ".#R#.....##OO####n#.",
    ".###...############.",
    "..#####R##########..",
    "..###r####R#######..",
    "..################..",
];
const WALK_A: [&str; 8] = [
    WALK_BODY[0], WALK_BODY[1], WALK_BODY[2], WALK_BODY[3],
    WALK_BODY[4], WALK_BODY[5], WALK_BODY[6],
    "..##..##....##..##..",
];
const WALK_B: [&str; 8] = [
    WALK_BODY[0], WALK_BODY[1], WALK_BODY[2], WALK_BODY[3],
    WALK_BODY[4], WALK_BODY[5], WALK_BODY[6],
    "...##..##..##..##...",
];
const WALK_C: [&str; 8] = [
    WALK_BODY[0], WALK_BODY[1], WALK_BODY[2], WALK_BODY[3],
    WALK_BODY[4], WALK_BODY[5], WALK_BODY[6],
    "..##...##...##...##.",
];

/// How many ticks between leg changes, and how long a blink lasts.
pub const WALK_EVERY: usize = 3;
pub const BLINK_EVERY: usize = 47;
pub const BLINK_FOR: usize = 2;

/// Flip art left-to-right. Directional glyphs swap with it, or the cat walks
/// one way with its whiskers pointing the other.
pub fn mirror(art: &[&str]) -> Vec<String> {
    art.iter().map(|row| row.chars().rev().map(|c| match c {
        '/' => '\\',
        '\\' => '/',
        other => other,
    }).collect()).collect()
}

/// One frame of Nyx pacing: which art, and how far from the left margin.
///
/// Everything is derived from a tick count, so the animation is a pure
/// function — the whole walk can be asserted in a test instead of watched.
pub fn pace(tick: usize, cols: usize) -> (Vec<String>, usize) {
    let w = width(WALK[0], SCALE_MASCOT);
    let travel = cols.saturating_sub(w).max(1);
    // out and back, so it turns around rather than teleporting to the left
    let pos = tick % (travel * 2);
    let (x, rightwards) = if pos < travel { (pos, true) } else { (travel * 2 - pos, false) };

    let mut art: Vec<String> = WALK[(tick / WALK_EVERY) % WALK.len()]
        .iter().map(|s| s.to_string()).collect();
    if tick % BLINK_EVERY < BLINK_FOR {
        art = art.into_iter().map(|r| r.replace('O', "_")).collect();
    }
    if !rightwards {
        let refs: Vec<&str> = art.iter().map(|s| s.as_str()).collect();
        art = mirror(&refs);
    }
    (art, x)
}

/// Nyx pacing, rendered as lines padded to `x`, ready to draw.
///
/// Empty when she does not fit. The same rule as the wordmark: shrink before
/// overflowing, and when there is nothing left to shrink to, do not draw. A
/// cat sheared off by the right edge is worse than no cat.
pub fn pace_lines(tick: usize, cols: usize) -> Vec<Line<'static>> {
    if cols < width(WALK[0], SCALE_MASCOT) { return Vec::new() }
    let (art, x) = pace(tick, cols);
    let refs: Vec<&str> = art.iter().map(|s| s.as_str()).collect();
    paint(&refs).into_iter().map(|line| {
        let mut spans = vec![Span::raw(" ".repeat(x))];
        spans.extend(line.spans);
        Line::from(spans)
    }).collect()
}

/// MNEMO at cell resolution: strokes three cells thick, with the half-cell
/// lip that gives the letterforms depth without needing a second colour.
/// Drawn at `SCALE_WORDMARK`.
pub const WORDMARK: &[&str] = &[
    "###.........###...###.........###...############...###.........###......#########",
    "######...######e..######......###e..###eeeeeeeeee..######...######e..###.eeeeeeee###",
    "###eee###.ee###e..###eee###...###e..#########......###eee###.ee###e..###e........###e",
    "###e...eee..###e..###e...ee######e..###eeeeeee.....###e...eee..###e..###e........###e",
    "###e........###e..###e......ee###e..############...###e........###e...ee#########.eee",
    ".eee.........eee...eee.........eee...eeeeeeeeeeee...eee.........eee......eeeeeeeee",
];

/// The same letterforms two cells thick, for a terminal under 90 columns.
pub const WORDMARK_SMALL: &[&str] = &[
    "##......##..##......##..########..##......##....######",
    "####..####e.####....##e.##eeeeeee.####..####e.##.eeeee##",
    "##ee##.e##e.##ee##..##e.######....##ee##.e##e.##e.....##e",
    "##e..ee.##e.##e..e####e.##eeeee...##e..ee.##e.##e.....##e",
    "##e.....##e.##e....e##e.########..##e.....##e..e######.ee",
    ".ee......ee..ee......ee..eeeeeeee..ee......ee....eeeeee",
];

/// The tagline. One line, lowercase, no exclamation.
pub const TAGLINE: &str = "memory that works like a brain";

/// How wide the art is, in terminal cells, at the scale it is drawn.
pub fn width(art: &[&str], scale: usize) -> usize {
    art.iter().map(|r| r.chars().count()).max().unwrap_or(0) * scale
}

/// What one marker is drawn with, at each scale, and in what colour.
///
/// Detail markers are NOT a repeated fill character — a whisker drawn twice is
/// two whiskers. Each marker carries its own two-cell and one-cell rendering,
/// which is what lets box-drawing detail (whiskers, a mouth, an eye) live in
/// the same grid as the solid coat.
pub fn ink(marker: char) -> (&'static str, &'static str, Color) {
    match marker {
        '#' => ("██", "█", COAT),
        'R' => ("▓▓", "▓", ROSETTE),
        'r' => ("▒▒", "▒", ROSETTE),
        // pale: muzzle, belly, inner ear
        'p' => ("▒▒", "▒", theme::PEACH),
        // An open eye is a HOLE in the coat, not a drawn shape. A drawn eye
        // at this size is two spiky glyphs and it reads as a glare — the
        // first detailed pass had `◗◖` here and the cat came out frightening.
        // Negative space is calm, and it needs no colour to work.
        'O' => ("  ", " ", theme::BLACK),
        // blinking simply closes the hole
        '_' => ("██", "█", COAT),
        'n' => ("▄▄", "▄", theme::ACCENT),
        '\\' => ("╲ ", "╲", theme::GREY),
        '-' => ("──", "─", theme::GREY),
        '/' => (" ╱", "╱", theme::GREY),
        'e' => ("▒▒", "▒", ROSETTE),
        _ => ("  ", " ", theme::BLACK),
    }
}

/// Turn marker rows into coloured lines, `scale` cells per marker.
pub fn paint_at(art: &[&str], scale: usize) -> Vec<Line<'static>> {
    art.iter().map(|row| {
        let mut spans: Vec<Span<'static>> = Vec::new();
        for c in row.chars() {
            let (wide, narrow, color) = ink(c);
            let glyph = if scale >= 2 { wide } else { narrow };
            // merge into the previous span when the colour has not changed:
            // one span per pixel is a lot of allocation for a splash screen
            match spans.last_mut() {
                Some(prev) if prev.style.fg == Some(color) => {
                    let mut s = prev.content.to_string();
                    s.push_str(glyph);
                    prev.content = s.into();
                }
                _ => spans.push(Span::styled(glyph.to_string(), Style::default().fg(color))),
            }
        }
        Line::from(spans)
    }).collect()
}

/// The mascot, at its own scale.
pub fn paint(art: &[&str]) -> Vec<Line<'static>> { paint_at(art, SCALE_MASCOT) }

/// The wordmark that fits in `cols`, or none when even the small one does not.
///
/// A wordmark that wraps is not a wordmark, so a narrow terminal gets the
/// tagline alone rather than a broken logo.
pub fn wordmark_for(cols: usize) -> Option<&'static [&'static str]> {
    if width(WORDMARK, SCALE_WORDMARK) + 4 <= cols { Some(WORDMARK) }
    else if width(WORDMARK_SMALL, SCALE_WORDMARK) + 4 <= cols { Some(WORDMARK_SMALL) }
    else { None }
}

/// The mascot that fits in `cols` beside `beside` cells of text.
pub fn cat_for(cols: usize, beside: usize) -> &'static [&'static str] {
    if width(CAT_SIT, SCALE_MASCOT) + beside + 6 <= cols { CAT_SIT }
    else if width(CAT_HEAD, SCALE_MASCOT) + beside + 4 <= cols { CAT_HEAD }
    else { CAT_TINY }
}

/// The splash: wordmark, tagline, mascot. Shown once, on first run.
pub fn splash(cols: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    if let Some(w) = wordmark_for(cols) {
        out.extend(paint_at(w, SCALE_WORDMARK));
        out.push(Line::from(""));
    }
    out.push(Line::from(Span::styled(
        TAGLINE, Style::default().fg(theme::GREY),
    )));
    out.push(Line::from(""));
    out.extend(paint(cat_for(cols, 0)));
    out
}

/// The welcome card: the mascot on the left, facts on the right, the way the
/// reference CLI does it. Rows shorter than the art are padded so the two
/// columns stay columns.
pub fn welcome(cols: usize, facts: &[(String, Style)]) -> Vec<Line<'static>> {
    let art = cat_for(cols, 40);
    let painted = paint(art);
    let gutter = "   ";
    let rows = painted.len().max(facts.len());
    // vertically centre the shorter column against the taller one
    let art_top = (rows - painted.len()) / 2;
    let fact_top = (rows - facts.len()) / 2;
    (0..rows).map(|i| {
        let mut spans: Vec<Span<'static>> = match i.checked_sub(art_top).and_then(|j| painted.get(j)) {
            Some(l) => l.spans.clone(),
            None => vec![Span::raw(" ".repeat(width(art, SCALE_MASCOT)))],
        };
        spans.push(Span::raw(gutter));
        if let Some((text, style)) = i.checked_sub(fact_top).and_then(|j| facts.get(j)) {
            spans.push(Span::styled(text.clone(), *style));
        }
        Line::from(spans)
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    #[test]
    fn every_art_row_is_the_same_width() {
        // a ragged row shears the mascot's right edge, and it is the kind of
        // thing you only notice on someone else's terminal
        let mut arts: Vec<(&str, &[&str])> =
            vec![("sit", CAT_SIT), ("head", CAT_HEAD), ("tiny", CAT_TINY)];
        for (i, f) in WALK.iter().enumerate() { arts.push((["walk0","walk1","walk2","walk3"][i], f)); }
        for (name, art) in arts {
            let widths: Vec<usize> = art.iter().map(|r| r.chars().count()).collect();
            assert!(widths.iter().all(|w| *w == widths[0]), "{name} is ragged: {widths:?}");
        }
    }

    #[test]
    fn the_art_uses_only_markers_the_painter_knows() {
        // an unknown marker silently becomes a hole in the cat
        let known = ['#', 'R', 'r', 'p', 'O', '_', 'n', '\\', '-', '/', 'e', '.'];
        let mut arts: Vec<&[&str]> = vec![CAT_SIT, CAT_HEAD, CAT_TINY, WORDMARK, WORDMARK_SMALL];
        arts.extend(WALK.iter().copied());
        for art in arts {
            for row in art {
                for c in row.chars() {
                    assert!(known.contains(&c), "unknown marker {c:?} in {row:?}");
                    let (wide, narrow, _) = ink(c);
                    assert_eq!(wide.chars().count(), 2, "{c:?} must be two cells wide");
                    assert_eq!(narrow.chars().count(), 1, "{c:?} must have a one-cell form");
                }
            }
        }
    }

    #[test]
    fn the_mascot_is_a_bengal_and_not_just_a_cat() {
        // rosettes and mascara are the breed; without them this is a
        // silhouette of any cat and the brand story is gone
        let body: String = CAT_SIT.concat();
        assert!(body.contains('R') && body.contains('r'), "no rosettes");
        assert!(body.matches('R').count() >= 8, "rosettes must cluster, not appear once");
        assert!(body.contains('n'), "no nose");
        // and the detail that blocks cannot carry at this size
        assert!(body.contains('O'), "no eyes");
        assert!(body.contains('-'), "no whiskers");
        assert!(body.contains('p'), "no inner ear");
        // the mascara sits on the same row as the eyes, flanking them
        let eyes = CAT_SIT.iter().find(|r| r.contains('O')).expect("an eye row");
        assert!(eyes.contains('R'), "no mascara beside the eyes: {eyes:?}");
    }

    #[test]
    fn an_open_eye_is_a_hole_and_a_blink_closes_it() {
        // a DRAWN eye at this size is two spiky glyphs and reads as a glare;
        // the first detailed pass did that and the cat came out frightening
        let (open, _, open_c) = ink('O');
        assert_eq!(open.trim(), "", "an open eye is negative space");
        assert_eq!(open_c, theme::BLACK);
        let (shut, _, shut_c) = ink('_');
        assert_eq!(shut, "██", "blinking closes the hole");
        assert_eq!(shut_c, COAT);
    }

    #[test]
    fn the_nose_is_the_only_accent_pixel() {
        // the tie between the mascot and the interface is one pixel; more than
        // one and it stops being a detail
        let painted = paint(CAT_SIT);
        let accent: usize = painted.iter()
            .flat_map(|l| l.spans.iter())
            .filter(|s| s.style.fg == Some(theme::ACCENT))
            .count();
        assert_eq!(accent, 1, "exactly one run of accent, the nose");
    }

    #[test]
    fn rosettes_are_drawn_from_the_thinking_animations_ramp() {
        // one density vocabulary in the whole product, used twice. Only the
        // rosette markers make that claim — a mouth is line art, not density.
        for m in ['R', 'r'] {
            let (wide, narrow, color) = ink(m);
            assert_eq!(color, ROSETTE);
            assert!(wide.chars().all(|c| theme::DITHER.contains(&c)), "{m:?} -> {wide:?}");
            assert!(narrow.chars().all(|c| theme::DITHER.contains(&c)), "{m:?} -> {narrow:?}");
        }
    }

    #[test]
    fn the_detail_markers_are_line_art_not_repeated_fill() {
        // a whisker drawn twice is two whiskers; the two-cell form of a detail
        // marker has to be the WHOLE mark, not the same glyph again
        // Only the asymmetric marks can prove it: a level whisker, a flat
        // nose and a gap eye genuinely ARE two of the same glyph.
        for m in ['/', '\\'] {
            let (wide, _, _) = ink(m);
            let chars: Vec<char> = wide.chars().collect();
            assert_ne!(chars[0], chars[1], "{m:?} renders as repeated fill: {wide:?}");
        }
        // whereas the fills genuinely are repeated
        for m in ['#', 'R', 'r', 'p'] {
            let (wide, _, _) = ink(m);
            let chars: Vec<char> = wide.chars().collect();
            assert_eq!(chars[0], chars[1], "{m:?} should be a fill");
        }
    }

    #[test]
    fn the_walk_cycle_loops_without_a_jump() {
        // frame 4 is frame 2 again, so the legs gather-spread-gather and the
        // loop point is invisible
        assert_eq!(WALK.len(), 4);
        assert_eq!(WALK[1], WALK[3], "the cycle ping-pongs rather than snapping back");
        // only the legs change; a body that shifts reads as a limp
        for f in WALK.iter() {
            assert_eq!(&f[..7], &WALK[0][..7], "only the last row may differ");
        }
        let legs: Vec<&str> = WALK.iter().map(|f| f[7]).collect();
        assert_eq!(legs.iter().collect::<std::collections::HashSet<_>>().len(), 3,
            "three distinct leg positions");
    }

    #[test]
    fn nyx_walks_out_and_back_rather_than_teleporting() {
        let cols = 80;
        let w = width(WALK[0], SCALE_MASCOT);
        let travel = cols - w;
        let x = |t: usize| pace(t, cols).1;
        assert_eq!(x(0), 0);
        assert_eq!(x(travel), travel, "reaches the far side");
        assert_eq!(x(travel + 1), travel - 1, "and turns around");
        assert_eq!(x(travel * 2), 0, "back where it started");
        // never off the edge, at any tick
        for t in 0..travel * 4 {
            assert!(x(t) + w <= cols, "tick {t} puts Nyx at {} in {cols}", x(t));
        }
    }

    #[test]
    fn she_faces_the_way_she_is_walking() {
        let cols = 80;
        let travel = cols - width(WALK[0], SCALE_MASCOT);
        let out = pace(1, cols).0;
        let back = pace(travel + 1, cols).0;
        assert_ne!(out, back, "the art flips with the direction");
        // mirroring is its own inverse
        let refs: Vec<&str> = CAT_SIT.to_vec();
        let once = mirror(&refs);
        let once_refs: Vec<&str> = once.iter().map(|s| s.as_str()).collect();
        assert_eq!(mirror(&once_refs), refs.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        // and a slanted whisker swaps hands, or she walks one way with her
        // whiskers pointing the other
        assert_eq!(mirror(&["/#\\"]), vec!["/#\\".to_string()]);
        assert_eq!(mirror(&["/##."]), vec![".##\\".to_string()]);
    }

    #[test]
    fn nyx_blinks_but_not_for_long() {
        let open = (0..BLINK_EVERY).filter(|t| !pace(*t, 80).0.concat().contains('_')).count();
        assert_eq!(open, BLINK_EVERY - BLINK_FOR, "eyes shut for {BLINK_FOR} of {BLINK_EVERY} frames");
        assert!(pace(0, 80).0.concat().contains('_'), "a blink happens at all");
    }

    #[test]
    fn a_narrow_terminal_does_not_push_her_off_the_screen() {
        // a cat wider than the terminal must still render at x=0 rather than
        // panicking on a subtraction
        for cols in [0, 1, 10, 39, 40, 41] {
            let (_, x) = pace(7, cols);
            assert!(x <= 1, "cols={cols} gave x={x}");
        }
        // and she is simply not drawn when there is no room for her
        assert!(pace_lines(3, 12).is_empty(), "a sheared cat is worse than none");
        assert!(!pace_lines(3, 80).is_empty());
    }

    #[test]
    fn painting_produces_one_cell_pair_per_pixel() {
        let line = &paint(CAT_HEAD)[4];
        assert_eq!(text(line).chars().count(), CAT_HEAD[4].chars().count() * SCALE_MASCOT);
    }

    #[test]
    fn a_narrow_terminal_drops_the_wordmark_rather_than_wrapping_it() {
        // a wrapped wordmark is not a wordmark
        assert_eq!(wordmark_for(200).map(|w| width(w, SCALE_WORDMARK)),
            Some(width(WORDMARK, SCALE_WORDMARK)));
        assert_eq!(wordmark_for(70).map(|w| width(w, SCALE_WORDMARK)),
            Some(width(WORDMARK_SMALL, SCALE_WORDMARK)), "83 cells of logo needs 87 columns");
        assert!(wordmark_for(30).is_none());
        // and the splash still says who this is
        let narrow: String = splash(30).iter().map(text).collect::<Vec<_>>().join("\n");
        assert!(narrow.contains(TAGLINE));
    }

    #[test]
    fn the_mascot_shrinks_before_it_overflows() {
        assert_eq!(width(cat_for(200, 0), SCALE_MASCOT), width(CAT_SIT, SCALE_MASCOT));
        assert_eq!(width(cat_for(52, 0), SCALE_MASCOT), width(CAT_HEAD, SCALE_MASCOT),
            "48 cells of cat needs 54 columns");
        assert_eq!(width(cat_for(20, 0), SCALE_MASCOT), width(CAT_TINY, SCALE_MASCOT));
        // and it leaves room for whatever sits beside it
        assert_eq!(width(cat_for(80, 40), SCALE_MASCOT), width(CAT_HEAD, SCALE_MASCOT));
    }

    #[test]
    fn the_welcome_card_keeps_its_two_columns_aligned() {
        let facts = vec![
            ("welcome back".to_string(), Style::default()),
            ("~/work/mnemo".to_string(), Style::default()),
        ];
        let card = welcome(120, &facts);
        let art_width = width(cat_for(120, 40), SCALE_MASCOT);
        // every row starts with the same number of art cells, including the
        // ones with no art left to draw
        for l in &card {
            let first: String = text(l);
            assert!(first.chars().count() >= art_width, "row too short: {first:?}");
        }
        let joined: String = card.iter().map(text).collect::<Vec<_>>().join("\n");
        assert!(joined.contains("welcome back") && joined.contains("~/work/mnemo"));
    }

    #[test]
    fn a_card_with_no_facts_is_still_just_the_cat() {
        let card = welcome(120, &[]);
        assert_eq!(card.len(), paint(cat_for(120, 40)).len());
    }
}

/// `mnemo-agent --brand` prints the whole identity, so it can be reviewed
/// without launching the app. A TUI is the one thing you cannot screenshot
/// from a script.
pub fn sheet(cols: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    out.extend(splash(cols));
    out.push(Line::from(""));
    out.extend(paint(CAT_HEAD));
    out.push(Line::from(""));
    out.extend(paint(CAT_TINY));
    out.push(Line::from(""));
    // the walk cycle, laid out as frames so it can be reviewed at a glance
    for (i, f) in WALK.iter().enumerate().take(3) {
        out.push(Line::from(format!("  frame {}", i + 1)));
        out.extend(paint(f));
    }
    out
}

#[cfg(test)]
mod installer_sync_tests {
    use super::*;

    /// The installer duplicates the walk art because the Rust binary does not
    /// exist yet at install time — there is nothing to ask. Duplication is
    /// fine; SILENT duplication is not, so this reads the JavaScript and fails
    /// the moment the two drift.
    fn installer_source() -> String {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..").join("agent").join("bin").join("install.ts");
        std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
    }

    fn array(src: &str, name: &str) -> Vec<String> {
        let start = src.find(&format!("export const {name} = [")).unwrap_or_else(
            || panic!("{name} is not exported from install.ts"));
        let rest = &src[start..];
        let end = rest.find("];").expect("unterminated array");
        rest[..end].lines().skip(1)
            .filter_map(|l| l.trim().trim_end_matches(',').strip_prefix('"'))
            .filter_map(|l| l.strip_suffix('"'))
            .map(|s| s.replace("\\\\", "\\"))
            .collect()
    }

    #[test]
    fn the_installers_walk_art_matches_this_one() {
        let src = installer_source();
        let body = array(&src, "WALK_BODY");
        assert_eq!(body, WALK[0][..7].iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "install.ts WALK_BODY has drifted from brand.rs");

        let legs = array(&src, "WALK_LEGS");
        let ours: Vec<String> = WALK.iter().map(|f| f[7].to_string()).collect();
        assert_eq!(legs, ours, "install.ts WALK_LEGS has drifted from brand.rs");
    }

    #[test]
    fn the_installers_wordmark_and_tagline_match() {
        let src = installer_source();
        assert_eq!(array(&src, "WORDMARK_SMALL"),
            WORDMARK_SMALL.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(src.contains(&format!("TAGLINE = \"{TAGLINE}\"")),
            "install.ts tagline has drifted");
    }

    #[test]
    fn the_installers_palette_matches_the_theme() {
        // a cat that is a different orange during install than after it is a
        // cat the user notices, in the wrong way
        let src = installer_source();
        for (color, label) in [(COAT, "COAT"), (ROSETTE, "ROSETTE"), (theme::ACCENT, "ACCENT"),
                               (theme::GREEN, "GREEN"), (theme::PEACH, "PEACH"), (theme::GREY, "GREY")] {
            let hex = theme::hex_of(color).expect("an rgb colour");
            let rgb = format!("RGB({}, {}, {})", hex >> 16, (hex >> 8) & 0xFF, hex & 0xFF);
            assert!(src.contains(&rgb), "{label} ({rgb}) is missing from install.ts");
        }
    }
}
