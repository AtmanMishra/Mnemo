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
  { name: "spawn_subagent", group: "agents", d: "Delegate a self-contained task to a sub-agent that works on its own and reports back: read-only for research, full to edit (you still approve). A sub-agent can start sub-agents of its own, to a limited depth." },
  { name: "list_agents", group: "agents", d: "List the agents this one can message: its parent and sub-agents, its linked siblings and its ancestors' siblings, each with its status, task and latest steps." },
  { name: "message_agent", group: "agents", d: "Send a short message to one of them. A running agent reads it after its current step; an idle one wakes up to read it and can answer. With wait, the reply comes back as the tool's result." },
  { name: "read · edit · write · bash · grep", group: "files", d: "The coding tools every turn uses, each one through the permission gate." },
];

export function Tools() {
  const [cur, setCur] = useState(0);
  return (
    <Section
      id="tools"
      n="08"
      eyebrow="what it can use"
      title="What tools does the agent have?"
      lead={<>The usual coding tools, plus memory it can search and correct, skills it can write, a Python kernel that can drive the other tools in parallel, and sub-agents it can hand work to.</>}
      figure={{ name: "relay", label: "A hub with four branches of tiles; the path to the leaf under the pointer lights hop by hop", means: "Work is handed down a path, hop by hop: to a program, to a sub-agent, and back with an answer." }}
      how={[
        { t: "A Python kernel that drives the other tools", d: <><code>ipy_run</code> runs Python in a persistent kernel whose state survives between calls. Inside it, <code>tools.read()</code>, <code>tools.bash()</code> and <code>tools.grep()</code> call the agent's tools, and <code>tools.parallel([...])</code> sends a whole batch at once: one program instead of a dozen round trips.</> },
        { t: "Sub-agents with a brief, not a transcript", d: <><code>spawn_subagent</code> hands a self-contained task to a child agent: read-only for research, or full to edit. The child gets a brief the parent wrote, the parent's model, and the same memory, so what it learns the parent can recall. Its steps stream into the parent's tool block, delegation is limited in depth, and you still approve its edits and commands. If its model call fails, the tool says why.</> },
        { t: "Memory it can search and correct", d: <><code>memory_search</code> and <code>session_search</code> look things up; <code>memory_remember</code> keeps a durable fact; <code>memory_steer</code> says that something memory supplied was wrong, so it is trusted less next time.</> },
        { t: "Skills it can write", d: <><code>create_skill</code> and <code>update_skill</code>, described above, plus the coding tools every turn uses: read, edit, write, bash and grep, each through the permission gate.</> },
      ]}
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
