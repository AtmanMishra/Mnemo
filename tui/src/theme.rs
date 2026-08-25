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

/// Spinner frame interval in milliseconds.
pub const SPINNER_INTERVAL_MS: u64 = 80;

/// Animated braille spinner frames (cycle every 80ms while THINKING).
pub const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/// Chunky pane title like "▚ CHAT ▞".
pub fn title(text: &str) -> String {
    format!("▚ {} ▞", text.to_uppercase())
}

/// Bold yellow title style used by all pane titles.
pub fn title_style() -> Style {
    Style::default().fg(YELLOW).add_modifier(Modifier::BOLD)
}

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
