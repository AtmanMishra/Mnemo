
# MNEMO UI Identity — Pixel Design System (v1)
Applies to ALL Mnemo surfaces: cockpit TUI, memory panes, CLI header/banners,
error/success states. The agent is Mnemo (Mnemosyne); the interface aesthetic is
PIXEL — chunky, quantized, restrained.

## Rules
1. Palette: PICO-8-inspired constants only (BLACK/DARKBLUE/PURPLE/RED/ORANGE/
   YELLOW/GREEN/BLUE/WHITE/GREY). Color = STATE, never decoration:
   green ok | red fail | yellow pending | blue info | orange user accent.
2. Frames: double-line borders for pane chrome only. No nested borders.
3. Titles: `# NAME #` bold-yellow pattern (pixel corner marks).
4. Meters/progress: braille dither cells, color shifts yellow->orange->red.
5. Icons: Nerd Font glyphs with ASCII fallback. NO emoji anywhere.
6. Typography: hierarchy via weight + color ONLY. No italics-for-emphasis.
7. Motion: braille spinner frames only; nothing else animates.
8. Fonts (user-side recommendation, graceful degradation): Silkscreen /
   Press Start 2P / Pixelify Sans terminal font preset documented in README;
   UI must be fully legible in plain monospace.
9. Minimalist restraint (per minimalist-ui): no gradients, no filler text,
   no AI cliches; whitespace via empty rows not decoration.

## Surfaces
- Interactive chat (pi InteractiveMode): status footer keeps native pi layout;
  header block + tool cards adopt pixel glyphs/colors where extensible.
- Cockpit TUI (planned nav-rail app): full pixel treatment per rules above.
- memtui/memsrv output: same palette constants, shared theme module target.
