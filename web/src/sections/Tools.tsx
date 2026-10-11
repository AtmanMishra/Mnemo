import { useState } from "react";
import { Section } from "./Section";

// Descriptions are the ones the model sees (app/src/extensions/*.ts), lightly shortened.
const TOOLS = [
  { name: "memory_search", group: "memory", d: "Search long-term memory for this project and user: conventions, past sessions, pitfalls and their fixes, lessons, skills." },
  { name: "session_search", group: "memory", d: "Search what was actually said and run in past sessions of this project — yours and other agents' (Claude Code)." },
  { name: "memory_remember", group: "memory", d: "Store a durable fact: scope project for this codebase, user for your preferences. The same key again replaces the old value, kept as history." },
  { name: "memory_steer", group: "memory", d: "Tell memory that something it supplied was wrong or that an approach failed, so it is trusted less next time." },
  { name: "create_skill", group: "skills", d: "Save a reusable procedure as a skill, a SKILL.md other sessions can load, when it worked out steps this project or user will need again." },
  { name: "update_skill", group: "skills", d: "Rewrite a skill that failed, saying what went wrong; the old version is kept." },
  { name: "ipy_run", group: "kernel", d: "Run Python in a persistent kernel. Inside, tools.read(), tools.bash(), tools.grep(), and tools.parallel([...]) to run several at once." },
  { name: "spawn_subagent", group: "agents", d: "Delegate a self-contained task to a sub-agent that works on its own and reports back: read-only for research, full to edit (you still approve)." },
  { name: "read · edit · write · bash · grep", group: "files", d: "The coding tools every turn uses, each one through the permission gate." },
  { name: "mcp__server__tool", group: "mcp", d: "Any MCP server in ~/.mnemo/mcp.json, registered under its own name." },
];

export function Tools() {
  const [cur, setCur] = useState(0);
  return (
    <Section
      id="tools"
      n="07"
      eyebrow="what it can use"
      title="What tools does the agent have?"
      lead={<>The usual coding tools, plus memory it can search and correct, skills it can write, a Python kernel that can drive the other tools in parallel, sub-agents, and your MCP servers.</>}
    >
      <div className="tools" data-reveal="">
        <div className="tool-list" role="listbox" aria-label="Tools" aria-activedescendant={`tool-${cur}`} tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); setCur((c) => (c + 1) % TOOLS.length); }
            if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); setCur((c) => (c - 1 + TOOLS.length) % TOOLS.length); }
          }}>
          {TOOLS.map((t, i) => (
            <div key={t.name} id={`tool-${i}`} role="option" aria-selected={i === cur} className={`tl-item g-${t.group}`} onClick={() => setCur(i)} onPointerEnter={(e) => e.pointerType === "mouse" && setCur(i)}>
              <code translate="no">{t.name}</code>
            </div>
          ))}
        </div>
        <div className="tool-desc" aria-live="polite">
          <p className="grp">{TOOLS[cur]!.group}</p>
          <p className="nm"><code translate="no">{TOOLS[cur]!.name}</code></p>
          <p>{TOOLS[cur]!.d}</p>
        </div>
      </div>
    </Section>
  );
}
