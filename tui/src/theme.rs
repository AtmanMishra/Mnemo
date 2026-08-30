//! PIXEL design system: PICO-8-inspired palette, titles, spinner, dither meters.
//! Everything degrades gracefully on monospace terminals without special fonts.

use ratatui::style::{Color, Modifier, Style};

pub const BLACK: Color = Color::Rgb(0x00, 0x00, 0x00);
pub const DARKBLUE: Color = Color::Rgb(0x1D, 0x2B, 0x53);
pub const PURPLE: Color = Color::Rgb(0x7E, 0x25, 0x53);
pub const RED: Color = Color::Rgb(0xFF, 0x00, 0x4D);
pub const ORANGE: Color = Color::Rgb(0xFF, 0xA3, 0x00);
pub const YELLOW: Color = Color::Rgb(0xFF, 0xEC, 0x27);
pub const GREEN: Color = Color::Rgb(0x00, 0xE4, 0x36);
pub const BLUE: Color = Color::Rgb(0x29, 0xAD, 0xFF);
pub const WHITE: Color = Color::Rgb(0xFF, 0xF1, 0xE8);
pub const GREY: Color = Color::Rgb(0x5F, 0x57, 0x4F);
pub const INDIGO: Color = Color::Rgb(0x83, 0x76, 0x9C);
pub const PINK: Color = Color::Rgb(0xFF, 0x77, 0xA8);
pub const PEACH: Color = Color::Rgb(0xFF, 0xCC, 0xAA);
pub const DARKGREY: Color = Color::Rgb(0x2B, 0x28, 0x25);

/// The one colour that means "this is the thing you are pointing at": pane
/// titles, the selected row, the prompt border, the user's own words.
///
/// It is PINK rather than YELLOW because yellow is what every terminal
/// programme already uses for a warning, so it reads as chrome rather than as
/// identity. Colour is state here, and the accent's state is "you".
pub const ACCENT: Color = PINK;

/// Spinner frame interval in milliseconds.
pub const SPINNER_INTERVAL_MS: u64 = 80;

/// Animated braille spinner frames (cycle every 80ms while THINKING).
pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Chunky pane title like "▚ CHAT ▞".
pub fn title(text: &str) -> String {
    format!("▚ {} ▞", text.to_uppercase())
}

/// Bold accent title style used by all pane titles.
pub fn title_style() -> Style {
    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
}

/// Dither glyphs, lightest to densest. The ramp is the whole animation
/// vocabulary: everything that pulses moves along it rather than blinking.
pub const DITHER: [char; 5] = [' ', '░', '▒', '▓', '█'];

/// One frame of the thinking animation: a dither wave `width` cells wide.
///
/// A spinner says "something is happening" in one cell. Thinking is not one
/// cell of work, so it gets a band: density travels left to right, so the eye
/// reads motion and direction rather than a twitching character. Pure, so the
/// animation is a unit test rather than something you have to watch.
pub fn dither_wave(phase: usize, width: usize) -> String {
    let width = width.max(1);
    (0..width)
        .map(|i| {
            // a triangle wave over the ramp, offset by position: adjacent
            // cells sit one step apart, which is what makes it read as travel
            let span = DITHER.len() * 2 - 2;
            let t = (i + phase) % span;
            let level = if t < DITHER.len() { t } else { span - t };
            DITHER[level]
        })
        .collect()
}

/// How many frames before `dither_wave` repeats, for a given width.
pub const DITHER_PERIOD: usize = DITHER.len() * 2 - 2;

/// Extract packed hex from a palette constant (for self-test verification).
pub fn hex_of(c: Color) -> Option<u32> {
    match c {
        Color::Rgb(r, g, b) => Some(((r as u32) << 16) | ((g as u32) << 8) | b as u32),
        _ => None,
    }
}

/// Braille dither progress meter. `fraction` 0.0..=1.0 across `width` cells.
/// Dense braille for filled, half-density cell for the fractional remainder,
/// blanks beyond. Degrades to plain spaces on any font.
pub fn dither_meter(fraction: f32, width: usize) -> String {
    let width = width.max(1);
    let frac = fraction.clamp(0.0, 1.0);
    let filled_exact = frac * width as f32;
    let full = filled_exact.floor() as usize;
    let rem = filled_exact - full as f32;
    let mut out = String::with_capacity(width * 3);
    for i in 0..width {
        if i < full {
            out.push('⣿');
        } else if i == full && rem >= 0.5 && full < width {
            out.push('⣤');
        } else {
            out.push(' ');
        }
    }
    out
}

/// Internal consistency checks surfaced by `seatui --self-test`.
pub fn checks() -> Vec<(String, bool)> {
    vec![
        ("theme:black".into(), hex_of(BLACK) == Some(0x000000)),
        ("theme:darkblue".into(), hex_of(DARKBLUE) == Some(0x1D2B53)),
        ("theme:purple".into(), hex_of(PURPLE) == Some(0x7E2553)),
        ("theme:red".into(), hex_of(RED) == Some(0xFF004D)),
        ("theme:orange".into(), hex_of(ORANGE) == Some(0xFFA300)),
        ("theme:yellow".into(), hex_of(YELLOW) == Some(0xFFEC27)),
        ("theme:green".into(), hex_of(GREEN) == Some(0x00E436)),
        ("theme:blue".into(), hex_of(BLUE) == Some(0x29ADFF)),
        ("theme:white".into(), hex_of(WHITE) == Some(0xFFF1E8)),
        ("theme:grey".into(), hex_of(GREY) == Some(0x5F574F)),
        (
            "theme:spinner-frames".into(),
            SPINNER.len() == 10 && SPINNER[0] == "⠋" && SPINNER[9] == "⠏",
        ),
        ("theme:title-format".into(), title("chat") == "▚ CHAT ▞"),
        ("theme:accent-is-not-yellow".into(), hex_of(ACCENT) == Some(0xFF77A8)),
        (
            "theme:dither-wave-moves".into(),
            dither_wave(0, 8) != dither_wave(1, 8)
                && dither_wave(0, 8) == dither_wave(DITHER_PERIOD, 8),
        ),
        (
            "theme:dither-full".into(),
            dither_meter(1.0, 10).chars().filter(|c| *c == '⣿').count() == 10,
        ),
        (
            "theme:dither-empty".into(),
            dither_meter(0.0, 8).chars().all(|c| c == ' '),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dither_wave_travels_instead_of_blinking() {
        // a spinner twitches in place; this has to read as motion, so adjacent
        // cells must differ and the pattern must shift by one each frame
        let a = dither_wave(0, 12);
        let b = dither_wave(1, 12);
        assert_ne!(a, b);
        assert_eq!(a.chars().count(), 12, "one glyph per cell");
        // frame n+1 is frame n shifted: cell i of b equals cell i+1 of a
        let a2: Vec<char> = dither_wave(0, 13).chars().collect();
        let b2: Vec<char> = dither_wave(1, 12).chars().collect();
        assert_eq!(b2, a2[1..], "the band moves rather than re-rolling");
    }

    #[test]
    fn the_wave_loops_cleanly() {
        // a visible jump at the loop point is worse than no animation
        assert_eq!(dither_wave(0, 10), dither_wave(DITHER_PERIOD, 10));
        assert_eq!(dither_wave(3, 10), dither_wave(3 + DITHER_PERIOD, 10));
    }

    #[test]
    fn every_glyph_comes_from_the_one_ramp() {
        // the design has a single density vocabulary; a stray character would
        // be a second one
        for phase in 0..DITHER_PERIOD {
            for c in dither_wave(phase, 20).chars() {
                assert!(DITHER.contains(&c), "{c:?} is not on the ramp");
            }
        }
    }

    #[test]
    fn a_zero_width_wave_is_still_one_cell() {
        assert_eq!(dither_wave(0, 0).chars().count(), 1);
    }

    #[test]
    fn the_accent_is_the_pico8_pink_not_a_warning_colour() {
        assert_eq!(hex_of(ACCENT), Some(0xFF77A8));
        assert_ne!(hex_of(ACCENT), hex_of(YELLOW), "yellow means warning everywhere else");
        assert!(checks().iter().all(|(_, ok)| *ok), "{:?}", checks());
    }
}
