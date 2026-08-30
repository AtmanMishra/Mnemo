//! Markdown-lite renderer for COMPLETED assistant messages.
//!
//! Produces styled segments per line; the caller maps SegStyle onto colors.
//! Supported: #/## headings (bold+underline), **bold**, `code`,
//! fenced code blocks (indented, dimmed, bordered), "- "/"* " bullets with
//! indentation, http(s) URLs (underlined/cyan at paint time).

use ratatui::text::{Line, Span};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegStyle {
    Plain,
    Heading,
    Bold,
    Code,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub text: String,
    pub style: SegStyle,
}

impl Segment {
    fn new(text: impl Into<String>, style: SegStyle) -> Self {
        Segment { text: text.into(), style }
    }
}

/// Find the earliest inline marker. Returns (byte_idx, kind).
fn next_marker(s: &str) -> Option<(usize, u8)> {
    // kinds: b'*' bold, b'`' code, b'u' url
    let mut best: Option<(usize, u8)> = None;
    for (idx, kind) in [
        (s.find("**"), b'*'),
        (s.find('`'), b'`'),
        (s.find("http://"), b'u'),
        (s.find("https://"), b'u'),
    ] {
        if let Some(i) = idx {
            if best.map_or(true, |(bi, _)| i < bi) {
                best = Some((i, kind));
            }
        }
    }
    best
}

/// Parse one line's inline markup into styled segments.
pub fn parse_inline(s: &str) -> Vec<Segment> {
    let mut segs: Vec<Segment> = Vec::new();
    let mut plain = String::new();
    let mut rest = s;
    'outer: loop {
        match next_marker(rest) {
            None => {
                plain.push_str(rest);
                break;
            }
            Some((idx, kind)) => {
                plain.push_str(&rest[..idx]);
                let tail = &rest[idx..];
                match kind {
                    b'*' => {
                        if let Some(close_rel) = tail[2..].find("**") {
                            let inner = &tail[2..2 + close_rel];
                            if !inner.is_empty() {
                                segs.push(Segment::new(std::mem::take(&mut plain), SegStyle::Plain));
                                segs.push(Segment::new(inner, SegStyle::Bold));
                                rest = &tail[2 + close_rel + 2..];
                                continue 'outer;
                            }
                        }
                        plain.push_str("**");
                        rest = &tail[2..];
                    }
                    b'`' => {
                        if let Some(close_rel) = tail[1..].find('`') {
                            let inner = &tail[1..1 + close_rel];
                            if !inner.is_empty() {
                                segs.push(Segment::new(std::mem::take(&mut plain), SegStyle::Plain));
                                segs.push(Segment::new(inner, SegStyle::Code));
                                rest = &tail[close_rel + 2..];
                                continue 'outer;
                            }
                        }
                        plain.push('`');
                        rest = &tail[1..];
                    }
                    _ => {
                        // URL: consume until whitespace or ')'
                        let end = tail
                            .char_indices()
                            .skip(1)
                            .find(|(_, c)| c.is_whitespace() || *c == ')')
                            .map(|(i, _)| i)
                            .unwrap_or(tail.len());
                        segs.push(Segment::new(std::mem::take(&mut plain), SegStyle::Plain));
                        segs.push(Segment::new(&tail[..end], SegStyle::Url));
                        rest = &tail[end..];
                    }
                }
            }
        }
    }
    if !plain.is_empty() {
        segs.push(Segment::new(plain, SegStyle::Plain));
    }
    segs
}

/// Render a full markdown document into styled lines.
pub fn render_markdown(src: &str) -> Vec<Vec<Segment>> {
    let mut out: Vec<Vec<Segment>> = Vec::new();
    let mut in_fence = false;
    for raw in src.lines() {
        let trimmed_start = raw.trim_start();
        if trimmed_start.starts_with("```") {
            in_fence = !in_fence;
            let border = if in_fence { "╭─ code " } else { "╰──────" };
            out.push(vec![Segment::new(border, SegStyle::Code)]);
            continue;
        }
        if in_fence {
            let indent_len = raw.len() - trimmed_start.len();
            let indent = " ".repeat(indent_len.min(6));
            out.push(vec![Segment::new(
                format!("│ {}{}", indent, trimmed_start),
                SegStyle::Code,
            )]);
            continue;
        }
        if let Some(rest) = trimmed_start.strip_prefix('#') {
            let text = rest.trim_start_matches('#').trim();
            out.push(vec![Segment::new(text, SegStyle::Heading)]);
            continue;
        }
        let leading = raw.len() - raw.trim_start().len();
        let bullet_body = trimmed_start
            .strip_prefix("- ")
            .or_else(|| trimmed_start.strip_prefix("* "));
        if let Some(body) = bullet_body {
            let level = leading / 2;
            let indent = "  ".repeat(level.min(3));
            let mut segs = vec![Segment::new(format!("{}• ", indent), SegStyle::Plain)];
            segs.extend(parse_inline(body));
            out.push(segs);
            continue;
        }
        out.push(parse_inline(raw));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn styles(line: &[Segment]) -> Vec<SegStyle> {
        line.iter().map(|s| s.style).collect()
    }

    #[test]
    fn heading_is_single_bold_segment() {
        let lines = render_markdown("## Setup guide");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], vec![Segment::new("Setup guide", SegStyle::Heading)]);
    }

    #[test]
    fn bold_and_code_and_plain_mix() {
        let segs = parse_inline("run **cargo test** with `--nocapture` flag");
        assert_eq!(segs[0], Segment::new("run ", SegStyle::Plain));
        assert_eq!(segs[1], Segment::new("cargo test", SegStyle::Bold));
        assert_eq!(segs[2], Segment::new(" with ", SegStyle::Plain));
        assert_eq!(segs[3], Segment::new("--nocapture", SegStyle::Code));
        assert_eq!(segs[4], Segment::new(" flag", SegStyle::Plain));
    }

    #[test]
    fn url_segment_detected() {
        let segs = parse_inline("see https://ratatui.rs docs");
        assert_eq!(styles(&segs), vec![SegStyle::Plain, SegStyle::Url, SegStyle::Plain]);
        assert_eq!(segs[1].text, "https://ratatui.rs");
    }

    #[test]
    fn fenced_code_block_bordered_and_dimmed() {
        let lines = render_markdown("before\n```bash\nls -la\n```\nafter");
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[1][0].style, SegStyle::Code);
        assert!(lines[1][0].text.starts_with("╭─"));
        assert_eq!(lines[2][0], Segment::new("│ ls -la", SegStyle::Code));
        assert!(lines[3][0].text.starts_with("╰"));
        assert_eq!(lines[4][0].style, SegStyle::Plain);
    }

    #[test]
    fn bullets_indent_by_level() {
        let lines = render_markdoc_helper();
        assert_eq!(lines[0][0].text, "• ");
        assert_eq!(lines[1][0].text, "  • ");
    }

    fn render_markdoc_helper() -> Vec<Vec<Segment>> {
        render_markdown("- top\n  - nested")
    }

    #[test]
    fn unclosed_marker_stays_literal() {
        let segs = parse_inline("a ** b");
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].text, "a ** b");
    }
}

/// Break one styled line to `width` cells, preserving span colours.
///
/// Ratatui's own `Wrap` would draw this correctly, but the Chat pane slices to
/// a line count BEFORE rendering — so a line that wraps into three rows pushes
/// two rows of the newest message off the bottom. Tail-anchoring only stays
/// honest if the pane wraps first and counts what it actually drew.
///
/// `indent` cells of blank are added to every row after the first, so a
/// wrapped message keeps its speaker gutter as a column.
pub fn wrap_line(line: &Line<'static>, width: usize, indent: usize) -> Vec<Line<'static>> {
    if width == 0 { return vec![line.clone()] }
    let total: usize = line.spans.iter().map(|s| s.content.chars().count()).sum();
    if total <= width { return vec![line.clone()] }

    let mut out: Vec<Line<'static>> = Vec::new();
    let mut row: Vec<Span<'static>> = Vec::new();
    let mut used = 0usize;
    let mut budget = width;

    for span in &line.spans {
        let style = span.style;
        let mut rest: &str = span.content.as_ref();
        while !rest.is_empty() {
            let room = budget.saturating_sub(used);
            if room == 0 {
                out.push(Line::from(std::mem::take(&mut row)));
                used = indent.min(width.saturating_sub(1));
                budget = width;
                if used > 0 { row.push(Span::raw(" ".repeat(used))); }
                continue;
            }
            let take = split_at_cells(rest, room, used == indent && !out.is_empty());
            if take == 0 {
                // nothing fits on this row and we are not at its start: break
                out.push(Line::from(std::mem::take(&mut row)));
                used = indent.min(width.saturating_sub(1));
                if used > 0 { row.push(Span::raw(" ".repeat(used))); }
                continue;
            }
            let byte = rest.char_indices().nth(take).map(|(i, _)| i).unwrap_or(rest.len());
            let (head, tail) = rest.split_at(byte);
            row.push(Span::styled(head.to_string(), style));
            used += head.chars().count();
            rest = tail;
            // a break mid-word leaves a leading space on the next row
            if used >= budget { rest = rest.trim_start_matches(' '); }
        }
    }
    if !row.is_empty() { out.push(Line::from(row)); }
    out
}

/// How many characters of `s` fit in `room` cells, preferring a word boundary
/// so a break does not land in the middle of a path or an identifier.
fn split_at_cells(s: &str, room: usize, at_row_start: bool) -> usize {
    let n = s.chars().count();
    if n <= room { return n }
    let hard = room;
    // look back for a space, but never give up more than a third of the row —
    // a long unbroken token has to be cut rather than pushed forever
    let floor = if at_row_start { 0 } else { room.saturating_sub(room / 3) };
    let mut best = 0;
    for (i, c) in s.chars().enumerate().take(hard) {
        if c == ' ' && i + 1 > floor { best = i + 1; }
    }
    if best > 0 { best } else { hard }
}

/// Wrap a whole block of lines.
pub fn wrap_all(lines: Vec<Line<'static>>, width: usize, indent: usize) -> Vec<Line<'static>> {
    lines.iter().flat_map(|l| wrap_line(l, width, indent)).collect()
}

#[cfg(test)]
mod wrap_tests {
    use super::*;
    use ratatui::style::{Color, Style};

    fn text(l: &Line) -> String { l.spans.iter().map(|s| s.content.to_string()).collect() }

    fn line(parts: &[(&str, Color)]) -> Line<'static> {
        Line::from(parts.iter()
            .map(|(t, c)| Span::styled(t.to_string(), Style::default().fg(*c)))
            .collect::<Vec<_>>())
    }

    #[test]
    fn a_short_line_is_left_exactly_alone() {
        let l = line(&[("hello", Color::Red)]);
        let out = wrap_line(&l, 40, 2);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].spans.len(), 1, "not rebuilt, not re-split");
    }

    #[test]
    fn a_long_line_breaks_at_a_space_and_keeps_its_gutter() {
        let l = line(&[("│ ", Color::Blue), ("the quick brown fox jumps over it", Color::White)]);
        let out = wrap_line(&l, 16, 2);
        assert!(out.len() > 1, "it wrapped");
        for row in &out {
            assert!(text(row).chars().count() <= 16, "row too wide: {:?}", text(row));
        }
        assert!(out[1..].iter().all(|r| text(r).starts_with("  ")),
            "continuations keep the gutter column: {:?}", out.iter().map(text).collect::<Vec<_>>());
        let joined: String = out.iter().map(text).collect::<Vec<_>>().join("");
        assert!(joined.contains("quick") && joined.contains("jumps"), "no words lost: {joined}");
    }

    #[test]
    fn colours_survive_the_break() {
        let l = line(&[("aaaa bbbb ", Color::Green), ("cccc dddd eeee", Color::Red)]);
        let out = wrap_line(&l, 12, 0);
        let greens: String = out.iter().flat_map(|r| r.spans.iter())
            .filter(|s| s.style.fg == Some(Color::Green))
            .map(|s| s.content.to_string()).collect();
        assert!(greens.contains("aaaa"), "green text stayed green: {greens:?}");
        let reds: String = out.iter().flat_map(|r| r.spans.iter())
            .filter(|s| s.style.fg == Some(Color::Red))
            .map(|s| s.content.to_string()).collect();
        assert!(reds.contains("eeee"), "and red stayed red: {reds:?}");
    }

    #[test]
    fn an_unbreakable_token_is_cut_rather_than_overflowing() {
        // a long path or hash has no space to break at; running off the right
        // edge is exactly the bug this exists to stop
        let l = line(&[("/Users/someone/a/very/long/path/without/spaces.rs", Color::White)]);
        let out = wrap_line(&l, 20, 2);
        assert!(out.len() > 1);
        for row in &out {
            assert!(text(row).chars().count() <= 20, "{:?}", text(row));
        }
    }

    #[test]
    fn a_zero_width_pane_does_not_loop_forever() {
        let l = line(&[("anything at all", Color::White)]);
        assert_eq!(wrap_line(&l, 0, 2).len(), 1);
        assert!(!wrap_line(&l, 1, 2).is_empty());
        assert!(!wrap_line(&l, 2, 8).is_empty(), "an indent wider than the pane");
    }

    #[test]
    fn wrap_all_flattens_a_block() {
        let ls = vec![
            line(&[("short", Color::White)]),
            line(&[("a much longer line that will certainly need two rows", Color::White)]),
        ];
        let out = wrap_all(ls, 20, 0);
        assert!(out.len() >= 3);
        assert!(out.iter().all(|r| text(r).chars().count() <= 20));
    }
}
