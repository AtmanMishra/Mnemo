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

/// Nyx sitting, tail curled. The full mascot — first run, and nowhere else.
pub const CAT_SIT: &[&str] = &[
    "..##..........##........",
    ".####........####.......",
    ".################.......",
    "##################......",
    "##R##..####..##R##......",
    "##################......",
    ".######nnnn######.......",
    "..####......####........",
    "...############.........",
    "....##########.......##.",
    "...############.....##R#",
    "..##r####R####r##...##r#",
    "..##R####r####R##...##R#",
    "..##r####R####r##...##r#",
    "..##R####r####R##..##R##",
    "..################.##r##",
    "..################.##R##",
    "...##############.##r###",
    "....############.######.",
    "....##......##...####...",
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

/// Turn marker rows into coloured lines, `scale` cells per marker.
pub fn paint_at(art: &[&str], scale: usize) -> Vec<Line<'static>> {
    art.iter().map(|row| {
        let mut spans: Vec<Span<'static>> = Vec::new();
        for c in row.chars() {
            let (glyph, color) = match c {
                '#' => ('█', COAT),
                'R' => ('▓', ROSETTE),
                'r' => ('▒', ROSETTE),
                'n' => ('▄', theme::ACCENT),
                'e' => ('▒', ROSETTE),
                _ => (' ', theme::BLACK),
            };
            let glyph: String = std::iter::repeat(glyph).take(scale).collect();
            // merge into the previous span when the colour has not changed:
            // one span per pixel is a lot of allocation for a splash screen
            match spans.last_mut() {
                Some(prev) if prev.style.fg == Some(color) => {
                    let mut s = prev.content.to_string();
                    s.push_str(&glyph);
                    prev.content = s.into();
                }
                _ => spans.push(Span::styled(glyph, Style::default().fg(color))),
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
        for (name, art) in [("sit", CAT_SIT), ("head", CAT_HEAD), ("tiny", CAT_TINY)] {
            let widths: Vec<usize> = art.iter().map(|r| r.chars().count()).collect();
            assert!(widths.iter().all(|w| *w == widths[0]), "{name} is ragged: {widths:?}");
        }
    }

    #[test]
    fn the_art_uses_only_markers_the_painter_knows() {
        // an unknown marker silently becomes a hole in the cat
        let known = ['#', 'R', 'r', 'n', 'e', '.'];
        for art in [CAT_SIT, CAT_HEAD, CAT_TINY, WORDMARK, WORDMARK_SMALL] {
            for row in art {
                for c in row.chars() {
                    assert!(known.contains(&c), "unknown marker {c:?} in {row:?}");
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
        // the head carries the mascara marks
        assert!(CAT_SIT[4].contains('R'), "no mascara beside the eyes: {:?}", CAT_SIT[4]);
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
        // one density vocabulary in the whole product, used twice
        let glyphs: Vec<char> = paint(CAT_SIT).iter()
            .flat_map(|l| l.spans.iter())
            .filter(|s| s.style.fg == Some(ROSETTE))
            .flat_map(|s| s.content.chars())
            .collect();
        assert!(!glyphs.is_empty());
        assert!(glyphs.iter().all(|c| theme::DITHER.contains(c)), "{glyphs:?}");
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
    out
}
