import { Section } from "./Section";

export function Agents() {
  return (
    <Section
      id="other-agents"
      n="08"
      eyebrow="detachable memory"
      title="Can Claude Code or Codex use the same memory?"
      lead={<>Yes. <code>mnemo memory setup claude-code</code> prints the hooks and MCP entry that give Claude Code (or Codex) the same memory, and <code>mnemo memory ingest</code> learns from the Claude Code sessions you already have. What one agent learns, the others recall.</>}
    >
      <div className="agents" data-reveal="">
        <svg viewBox="0 0 640 240" role="img" aria-label="Mnemo, Claude Code and Codex all reading and writing one local memory">
          <path className="wire" d="M120 60 C 230 60, 230 120, 320 120" />
          <path className="wire" d="M120 180 C 230 180, 230 120, 320 120" />
          <path className="wire" d="M520 120 L 320 120" />
          <g className="box"><rect x="20" y="36" width="140" height="48" rx="8" /><text x="90" y="65">Mnemo</text></g>
          <g className="box"><rect x="20" y="156" width="140" height="48" rx="8" /><text x="90" y="185">Claude Code</text></g>
          <g className="box"><rect x="500" y="96" width="120" height="48" rx="8" /><text x="560" y="125">Codex</text></g>
          <g className="core"><rect x="250" y="88" width="140" height="64" rx="10" /><text x="320" y="117">memory</text><text x="320" y="137" className="sub">memsrv · local</text></g>
        </svg>
        <div className="cmds">
          <pre><span className="p">$</span> mnemo memory setup claude-code</pre>
          <pre><span className="p">$</span> mnemo memory ingest</pre>
        </div>
      </div>
    </Section>
  );
}
