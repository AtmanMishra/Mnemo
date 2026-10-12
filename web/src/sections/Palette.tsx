import { useMemo, useState } from "react";
import { Section } from "./Section";

// The built-in commands, with their own descriptions (app/src/runtime and extensions).
const COMMANDS: [string, string][] = [
  ["memory", "what Mnemo remembers · /memory <words> searches it"],
  ["remember", "tell Mnemo something to keep: /remember we deploy with fly"],
  ["forget", "retire a remembered fact: /forget package manager"],
  ["bestof", 'race N attempts at a task, keep the smallest that passes: /bestof 3 "npm test" <task>'],
  ["skills", "the skills Mnemo can load"],
  ["mode", "how much Mnemo may do without asking (default, accept-edits, plan, yolo)"],
  ["plan", "toggle plan mode (read-only)"],
  ["accept-edits", "toggle accept edits: change project files without asking, still ask before commands"],
  ["yolo", "toggle bypass: ask for nothing (deny rules in permissions.json still hold)"],
  ["model", "choose the model"],
  ["thinking", "set how hard the model thinks"],
  ["login", "add a provider (API key or subscription)"],
  ["logout", "remove a provider's credentials"],
  ["theme", "the look: Mnemo Night, Game Boy, Paper"],
  ["resume", "continue an earlier session in this folder"],
  ["new", "start a fresh session"],
  ["compact", "summarise the conversation to free context"],
  ["cost", "tokens and spend for this session"],
  ["reload", "reload skills, prompts and extensions"],
  ["clear", "clear the screen (the session is kept)"],
  ["help", "commands and keys"],
  ["quit", "leave Mnemo"],
];

export function Palette() {
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const hits = useMemo(() => {
    const s = q.replace(/^\//, "").toLowerCase();
    return COMMANDS.filter(([n, d]) => n.includes(s) || d.toLowerCase().includes(s));
  }, [q]);
  const active = Math.min(cur, Math.max(0, hits.length - 1));

  return (
    <Section
      id="commands"
      n="10"
      eyebrow="commands"
      title="What can I type?"
      lead={<>Type <kbd>/</kbd> in Mnemo for every command: these built-ins, your skills, and whatever the agent's extensions add. Try it here.</>}
      figure={{ name: "keyboard", label: "A sixty-key board; the key under the pointer sinks and its neighbours follow it down", means: "Everything is a key or a slash away; the keys you reach for most never animate." }}
    >
      <div className="palette" data-reveal="">
        <div className="pal-in">
          <span aria-hidden="true">/</span>
          <input
            aria-label="Filter commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="pal-list"
            aria-activedescendant={hits[active] ? `cmd-${hits[active]![0]}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="mem…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setCur(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setCur((c) => Math.min(hits.length - 1, c + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setCur((c) => Math.max(0, c - 1)); }
            }}
          />
          <span className="count">{hits.length}</span>
        </div>
        <ul id="pal-list" role="listbox" aria-label="Commands">
          {hits.map(([n, d], i) => (
            <li key={n} id={`cmd-${n}`} role="option" aria-selected={i === active} onPointerEnter={(e) => e.pointerType === "mouse" && setCur(i)}>
              <code translate="no">/{n}</code><span>{d}</span>
            </li>
          ))}
          {hits.length === 0 && <li className="none">No command matches. In Mnemo, a name it does not know is passed to the agent.</li>}
        </ul>
      </div>
    </Section>
  );
}
