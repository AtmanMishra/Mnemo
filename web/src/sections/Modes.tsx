import { useState } from "react";
import { Section } from "./Section";

// The gate, as app/src/policy/gate.ts decides it: reads always run; plan refuses
// every change; deny rules in permissions.json hold in every mode, yolo included.
type Verdict = "run" | "ask" | "refuse";
const MODES = [
  { id: "default", label: "default", note: "Asks before every edit and command." },
  { id: "accept-edits", label: "accept-edits", note: "Changes project files without asking; still asks before commands." },
  { id: "plan", label: "plan", note: "Read-only: describes the change instead of making it." },
  { id: "yolo", label: "yolo", note: "Asks for nothing. Use it in a container or a throwaway checkout." },
] as const;
type Mode = (typeof MODES)[number]["id"];

const ACTIONS: { what: string; tool: string; v: Record<Mode, Verdict> }[] = [
  { what: "read src/fetch.ts", tool: "read", v: { default: "run", "accept-edits": "run", plan: "run", yolo: "run" } },
  { what: "edit src/fetch.ts", tool: "edit", v: { default: "ask", "accept-edits": "run", plan: "refuse", yolo: "run" } },
  { what: "pnpm test", tool: "bash", v: { default: "ask", "accept-edits": "ask", plan: "refuse", yolo: "run" } },
  { what: "a command your deny rules match", tool: "bash", v: { default: "refuse", "accept-edits": "refuse", plan: "refuse", yolo: "refuse" } },
];
const WORD: Record<Verdict, string> = { run: "runs", ask: "asks you", refuse: "refused" };

export function Modes() {
  const [mode, setMode] = useState<Mode>("default");
  const m = MODES.find((x) => x.id === mode)!;
  return (
    <Section
      id="safety"
      n="07"
      eyebrow="permissions"
      title="Is it safe to let it run commands?"
      lead={<>By default it asks before every edit and command. Four modes set how much it may do on its own, and ordered allow / ask / deny rules in <code>~/.mnemo/permissions.json</code> hold in all of them. The gate filters what runs; it is not a sandbox.</>}
      figure={{ name: "vault", label: "A vault door with a dial and three bolts; the pointer turns the dial, and on the combination the bolts draw back", means: "Nothing opens by accident: each kind of action has its own combination, and you set it." }}
      how={[
        { t: "A deny rule outranks everything", d: <>Rules in <code>~/.mnemo/permissions.json</code> say <code>allow</code>, <code>ask</code> or <code>deny</code> for a tool and a pattern. A deny holds in every mode, <code>/yolo</code> included, with or without a terminal: “stop asking” is a statement about questions, not about permissions.</> },
        { t: "Approvals generalise by subcommand, never by program", d: <>Approving <code>git status --short</code> “always” covers <code>git status*</code>, never <code>git*</code>, which would also hand over <code>git push</code> and <code>git clean -xdf</code>. Arguments never generalise: a path is not a class.</> },
        { t: "A compound command never inherits a grant", d: <><code>ls; rm -rf /</code> matches an approved <code>ls*</code> and must not use it. Anything with a shell metacharacter is its own question.</> },
        { t: "Ask is the default", d: <>There is no fallthrough that quietly allows. Plan mode refuses every change and tells the model to describe it instead. Sub-agents and programs in the Python kernel go through the same gate, and you still answer for every edit and command they make.</> },
        { t: "A filter, not a sandbox", d: <>Commands run as you and inherit your environment, provider keys included, which a prompt injection could try to read. Use <code>/yolo</code> and headless <code>-p</code> in a container or a throwaway checkout.</> },
      ]}
    >
      <div className="modes" data-reveal="">
        <div className="seg" role="radiogroup" aria-label="Mode">
          {MODES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={x.id === mode} onClick={() => setMode(x.id)}>/{x.label}</button>
          ))}
        </div>
        <p className="mode-note" aria-live="polite">{m.note}</p>
        <table className="gate">
          <caption className="visually-hidden">What happens to each action in {m.label} mode</caption>
          <thead><tr><th scope="col">The agent wants to</th><th scope="col">Tool</th><th scope="col">In /{m.label}</th></tr></thead>
          <tbody>
            {ACTIONS.map((a) => (
              <tr key={a.what}>
                <th scope="row"><code>{a.what}</code></th>
                <td className="mut">{a.tool}</td>
                <td><span key={`${mode}-${a.what}`} className={`verdict ${a.v[mode]}`}>{WORD[a.v[mode]]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
