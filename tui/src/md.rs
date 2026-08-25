//! Markdown-lite renderer for COMPLETED assistant messages.
//!
//! Produces styled segments per line; the caller maps SegStyle onto colors.
//! Supported: #/## headings (bold+underline), **bold**, `code`,
//! fenced code blocks (indented, dimmed, bordered), "- "/"* " bullets with
//! indentation, http(s) URLs (underlined/cyan at paint time).

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
