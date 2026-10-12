import { useState } from "react";
import { Section } from "./Section";
import { SPRITE_ROWS } from "../art/sprite";

// The palettes from app/src/ui/theme.ts. Each theme is a class that sets the
// mock's colour variables in styles.css; the sprite is drawn with those variables.
const THEMES = [
  { id: "night", label: "Mnemo Night" },
  { id: "gameboy", label: "Game Boy" },
  { id: "paper", label: "Paper" },
  { id: "dracula", label: "Dracula" },
  { id: "nord", label: "Nord" },
  { id: "gruvbox", label: "Gruvbox" },
  { id: "tokyo", label: "Tokyo Night" },
  { id: "mocha", label: "Catppuccin" },
  { id: "solarized", label: "Solarized" },
  { id: "amber", label: "Amber CRT" },
  { id: "synthwave", label: "Synthwave" },
] as const;

const SPRITE_VARS = ["ground", "outline", "shade", "hide", "blush", "tusk"];

function Mne() {
  const cells: JSX.Element[] = [];
  SPRITE_ROWS.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== ".") cells.push(<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" className={`px-${SPRITE_VARS[ch.charCodeAt(0) - 97]}`} />);
    }),
  );
  return <svg viewBox="0 0 18 18" shapeRendering="crispEdges" className="th-mne" aria-hidden="true">{cells}</svg>;
}

export function Themes() {
  const [t, setT] = useState<(typeof THEMES)[number]["id"]>("night");
  return (
    <Section
      id="themes"
      n="11"
      eyebrow="the interface"
      title="Why does it look like a game?"
      lead={<>Because a long session should be pleasant to watch. Mne the elephant reacts to the work, diffs and test runs are drawn as pixels, and <code>/theme</code> switches between eleven palettes that keep the same roles: magenta for the agent, cyan for structure, amber for anything memory did.</>}
      figure={{ name: "exploded", label: "An app window in four layers; moving across opens the gap and moving down picks a layer", means: "The interface in layers: the transcript is the application, and everything else floats over it." }}
    >
      <div className="themes" data-reveal="">
        <div className="seg" role="radiogroup" aria-label="Theme">
          {THEMES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={x.id === t} onClick={() => setT(x.id)}>{x.label}</button>
          ))}
        </div>
        <div className={`th th-${t}`}>
          <div className="th-side">
            <Mne />
            <p className="th-h">files</p>
            <p>src/<b>fetch.ts</b> <i>M</i></p>
            <p className="th-h">memory</p>
            <p><em>◆</em> http helper</p>
            <p><em>◆</em> language</p>
          </div>
          <div className="th-main">
            <p><span className="you">▊</span> add a retry to the fetch helper</p>
            <p><span className="tool">●</span> edit <span className="cy">src/fetch.ts</span></p>
            <p className="th-diff"><span className="a">+ for (let attempt = 1; ; attempt++) {"{"}</span><span className="d">- const res = await fetch(url);</span></p>
            <p><span className="agent">│</span> Done: server errors retry up to three times.</p>
            <p><em>◆ +2 learned</em></p>
            <p className="th-status"><span>default</span><span>demo-model</span></p>
          </div>
        </div>
      </div>
    </Section>
  );
}
