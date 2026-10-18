/// <reference lib="dom" />
import type { Block, Dialog, Mode, RosterNode, RpcEvent, SettingDef } from "../protocol";
import { initial, matchCommands, reduce, tree, type State } from "./reduce.js";
import { THEME_CHOICES, themeVars } from "./theme.js";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const vscode = acquireVsCodeApi();

type Tab = "chat" | "agents" | "memory" | "settings";
let state: State = initial();
let host = { running: false, problem: undefined as string | undefined, version: "" };
let tab: Tab = "chat";
let pendingYolo = false;
let theme = "editor";

function applyTheme(): void {
  const root = document.documentElement;
  const t = themeVars(theme);
  for (const k of themeKeys) root.style.removeProperty(k);
  if (t) for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
  root.style.colorScheme = t?.scheme ?? "";
}
const themeKeys = Object.keys(themeVars("night")!.vars);
let history: string[] = [];
let historyAt = -1;
const openTools = new Set<string>();
let memoryKey = 0;
const memoryWaiting = new Map<number, (v: any) => void>();
let memoryView: State["memory"];

// ---- small DOM helpers (text only goes in through textContent: nothing here parses HTML) ----

type Kid = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (k in el) (el as any)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== false && kid !== undefined) el.append(kid);
  return el;
}

const cmd = (msg: Record<string, unknown>) => vscode.postMessage({ type: "cmd", msg });
const send = (text: string) => cmd({ type: "submit", text });

// ---- markdown, as DOM nodes ----

function inline(text: string): Node[] {
  const out: Node[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(document.createTextNode(text.slice(last, m.index)));
    const t = m[0];
    out.push(t.startsWith("`") ? h("code", { text: t.slice(1, -1) }) : h("strong", { text: t.slice(2, -2) }));
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function codeBlock(code: string): HTMLElement {
  return h("div", { class: "code" }, h("button", { class: "copy", title: "Copy", text: "Copy", onclick: () => vscode.postMessage({ type: "copy", text: code }) }), h("pre", {}, h("code", { text: code })));
}

export function markdown(text: string): HTMLElement {
  const root = h("div", { class: "md" });
  const parts = text.split(/^(```[^\n]*\n[\s\S]*?(?:\n```|$))/m);
  for (const part of parts) {
    if (part.startsWith("```")) {
      root.append(codeBlock(part.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "")));
      continue;
    }
    let list: HTMLElement | undefined;
    for (const line of part.split("\n")) {
      const li = /^\s*(?:[-*]|\d+\.)\s+(.*)/.exec(line);
      if (li) {
        const tag = /^\s*\d/.test(line) ? "ol" : "ul";
        if (!list || list.tagName.toLowerCase() !== tag) root.append((list = h(tag)));
        list.append(h("li", {}, ...inline(li[1]!)));
        continue;
      }
      list = undefined;
      const hd = /^(#{1,4})\s+(.*)/.exec(line);
      if (hd) root.append(h("div", { class: "h" }, ...inline(hd[2]!)));
      else if (line.trim()) root.append(h("p", {}, ...inline(line)));
    }
  }
  return root;
}

// ---- blocks ----

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const subjectOf = (b: Extract<Block, { kind: "tool" }>): string => str(b.args.path) || str(b.args.file_path) || str(b.args.command) || str(b.args.pattern) || str(b.args.query) || str(b.args.url);

function diffLines(diff: string): HTMLElement {
  const pre = h("pre", { class: "diff" });
  for (const line of diff.split("\n")) pre.append(h("div", { class: /^\+\s*\d/.test(line) ? "add" : /^-\s*\d/.test(line) ? "del" : "ctx", text: line || " " }));
  return pre;
}

function diffStat(diff: string): string {
  let a = 0;
  let r = 0;
  for (const l of diff.split("\n")) /^\+\s*\d/.test(l) ? a++ : /^-\s*\d/.test(l) && r++;
  return `+${a} −${r}`;
}

function toolBlock(b: Extract<Block, { kind: "tool" }>): HTMLElement {
  const diff = (b.details as { diff?: string } | undefined)?.diff;
  const file = str(b.args.path) || str(b.args.file_path);
  const icon = { pending: "◌", running: "◐", done: "✓", error: "✗" }[b.status];
  const summary = b.status === "error" ? b.output.split("\n")[0] : diff ? diffStat(diff) : "";
  const el = h("details", { class: `tool ${b.status}`, open: openTools.has(b.id) || b.status === "running" || (b.name === "edit" && !!diff) });
  el.addEventListener("toggle", () => (el.open ? openTools.add(b.id) : openTools.delete(b.id)));
  el.append(
    h("summary", {}, h("span", { class: "ti", text: icon }), h("span", { class: "tn", text: b.name }), h("span", { class: "ts", text: subjectOf(b) }), summary && h("span", { class: "tsum", text: summary })),
  );
  const body = h("div", { class: "tbody" });
  if (diff) body.append(diffLines(diff));
  else if (b.name === "write" && str(b.args.content)) body.append(h("pre", { class: "out", text: str(b.args.content).split("\n").slice(0, 60).join("\n") }));
  else if (b.output.trim()) body.append(h("pre", { class: "out", text: b.output.split("\n").slice(-80).join("\n") }));
  if (file && (b.name === "edit" || b.name === "write" || b.name === "read")) body.append(h("button", { class: "link", text: `Open ${file}`, onclick: () => vscode.postMessage({ type: "openFile", path: file }) }));
  el.append(body);
  return el;
}

function blockEl(b: Block): HTMLElement {
  switch (b.kind) {
    case "welcome":
      return h("div", { class: "welcome" }, h("div", { class: "wtitle", text: "Mnemo" }), h("div", { text: "A coding agent that remembers this project. Ask for a change, or type / for commands." }));
    case "user":
      return h("div", { class: "msg user" }, h("div", { class: "who", text: "You" }), h("div", { class: "text", text: b.text }));
    case "assistant":
      return h("div", { class: "msg assistant" }, h("div", { class: "who", text: "Mnemo" }), markdown(b.text), !b.done && h("span", { class: "caret" }));
    case "thinking":
      return h("details", { class: "thinking" }, h("summary", { text: b.done ? `Thought${b.durationMs ? ` for ${Math.max(1, Math.round(b.durationMs / 1000))}s` : ""}` : "Thinking…" }), h("div", { class: "text", text: b.text }));
    case "tool":
      return toolBlock(b);
    case "notice":
      return h("div", { class: `notice ${b.tone}` }, h("span", { text: b.text }), b.extra?.code && h("code", { class: "devcode", text: b.extra.code }), ...(b.extra?.links ?? []).map((l) => h("span", { class: "linkurl", text: l.label ?? l.url, title: l.url })));
    case "memory":
      return h("div", { class: "memnote" }, h("div", { class: "mt", text: `◈ ${b.title}` }), h("ul", {}, ...b.items.map((i) => h("li", { text: i }))));
    case "peer":
      return h("div", { class: "msg peer" }, h("div", { class: "who", text: `Agent ${b.label || b.from}` }), h("div", { class: "text", text: b.text }));
  }
}

// ---- dialogs ----

function dialogEl(d: Dialog): HTMLElement {
  const answer = (extra: Record<string, unknown>) => cmd({ type: "answer", id: d.id, ...extra });
  if (d.kind === "approval") {
    const feedback = h("input", { type: "text", placeholder: "Or tell Mnemo what to do instead (optional)", class: "feedback" });
    return h(
      "div",
      { class: "dialog approval", role: "alertdialog", "aria-label": "Mnemo is asking for permission" },
      h("div", { class: "dtitle" }, "Allow ", h("strong", { text: d.tool }), "?"),
      h("code", { class: "subject", text: d.subject }),
      d.reason && h("div", { class: "reason", text: d.reason }),
      d.preview.length > 0 &&
        h("pre", { class: "diff preview" }, ...d.preview.slice(0, 300).map((l) => h("div", { class: l.tone === "add" ? "add" : l.tone === "remove" ? "del" : "ctx", text: l.text || " " }))),
      feedback,
      h(
        "div",
        { class: "buttons" },
        h("button", { class: "primary", text: "Allow once", onclick: () => answer({ answer: { kind: "yes" } }) }),
        d.always && h("button", { text: "Always allow", title: d.always, onclick: () => answer({ answer: { kind: "always" } }) }),
        h("button", { class: "danger", text: "Deny", onclick: () => answer({ answer: { kind: "no", feedback: feedback.value.trim() || undefined } }) }),
      ),
      d.always && h("div", { class: "hint", text: `Always allow covers: ${d.always}` }),
    );
  }
  if (d.kind === "confirm")
    return h("div", { class: "dialog" }, h("div", { class: "dtitle", text: d.title }), h("div", { class: "reason", text: d.message }), h("div", { class: "buttons" }, h("button", { class: "primary", text: "Yes", onclick: () => answer({ ok: true }) }), h("button", { text: "No", onclick: () => answer({ ok: false }) })));
  if (d.kind === "text") {
    const input = h("input", { type: d.secret ? "password" : "text", placeholder: d.placeholder ?? "", value: d.initial ?? "", autocomplete: "off", class: "feedback" });
    input.addEventListener("keydown", (e) => e.key === "Enter" && answer({ value: input.value }));
    queueMicrotask(() => input.focus());
    return h("div", { class: "dialog" }, h("div", { class: "dtitle", text: d.title }), input, h("div", { class: "buttons" }, h("button", { class: "primary", text: "OK", onclick: () => answer({ value: input.value }) }), h("button", { text: "Cancel", onclick: () => answer({}) })));
  }
  const filter = h("input", { type: "text", placeholder: "Filter", class: "feedback" });
  const list = h("div", { class: "choices" });
  const fill = () => {
    list.replaceChildren();
    const q = filter.value.toLowerCase();
    for (const c of d.choices.filter((c) => !q || `${c.label} ${c.description ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q)).slice(0, 200))
      list.append(h("button", { class: `choice${c.value === d.initial ? " current" : ""}`, onclick: () => answer({ value: c.value }) }, h("span", { text: c.label }), c.description && h("small", { text: c.description })));
  };
  filter.addEventListener("input", fill);
  fill();
  return h("div", { class: "dialog" }, h("div", { class: "dtitle", text: d.title }), d.choices.length > 8 && filter, list, h("div", { class: "buttons" }, h("button", { text: "Cancel", onclick: () => answer({}) })));
}

// ---- header ----

const MODE_LABEL: Record<Mode, string> = { default: "Ask first", "accept-edits": "Accept edits", plan: "Plan", yolo: "Bypass" };

function themePicker(): HTMLElement {
  const sel = h("select", { class: "theme", title: "Theme", "aria-label": "Theme" }, ...THEME_CHOICES.map((c) => h("option", { value: c.value, text: c.label, selected: c.value === theme })));
  sel.addEventListener("change", () => {
    theme = sel.value;
    applyTheme();
    vscode.postMessage({ type: "setTheme", theme });
  });
  return sel;
}

function header(): HTMLElement {
  const f = state.footer;
  const bar = h("div", { class: "header" });
  if (!f) return (bar.append(h("span", { class: "brand", text: "mnemo" }), h("span", { class: "dim", text: host.running ? "Starting Mnemo…" : "Mnemo is not running" }), themePicker()), bar);
  const mode = h("select", { class: "mode", title: "How much Mnemo may do without asking", "aria-label": "Mode" }, ...(Object.keys(MODE_LABEL) as Mode[]).map((m) => h("option", { value: m, text: MODE_LABEL[m], selected: m === f.mode })));
  mode.addEventListener("change", () => {
    if (mode.value === "yolo") {
      pendingYolo = true;
      mode.value = f.mode;
      render();
    } else cmd({ type: "setMode", mode: mode.value });
  });
  const ctx = f.contextPercent;
  bar.append(
    ...[h("span", { class: "brand", text: "mnemo" }), h("span", { class: "chip model", title: "Model", text: f.model }),
    f.thinking && h("button", { class: "chip", title: "Thinking level (click to cycle)", text: `thinking: ${f.thinking}`, onclick: () => cmd({ type: "cycleThinking" }) }),
    mode,
    ctx !== null && h("span", { class: "chip", title: "Context used" }, `ctx ${Math.round(ctx)}%`, h("span", { class: "meter" }, h("span", { style: `width:${Math.min(100, ctx)}%` }))),
    h("span", { class: "chip", title: "Spent this session", text: `$${f.cost.toFixed(2)}` }),
    f.memory && h("button", { class: `chip${f.memory.answering ? "" : " warn"}`, title: f.memory.answering ? "Memory nodes (click to open)" : "Memory is not answering", text: `◈ ${f.memory.nodes ?? "?"}`, onclick: () => setTab("memory") }),
    f.branch && h("span", { class: "chip dim", title: "Git branch", text: f.branch }),
    themePicker(),
  ].filter((k): k is HTMLElement => !!k));
  return bar;
}

// ---- tabs ----

function setTab(t: Tab): void {
  tab = t;
  if (t === "memory") loadMemory("");
  render();
}

function loadMemory(query: string): void {
  const key = ++memoryKey;
  vscode.postMessage({ type: "request", key, msg: { type: "memory", query } });
  memoryWaiting.set(key, (r) => {
    memoryView = r.ok ? (r.value as State["memory"]) : { available: false };
    render();
  });
}

function agentsView(): HTMLElement {
  const root = h("div", { class: "pane" });
  const nodes = tree(state.roster);
  if (!nodes.length) return root.appendChild(h("div", { class: "empty", text: "No agents yet." })).parentElement!;
  for (const { node, depth } of nodes) root.append(agentRow(node, depth));
  root.append(h("p", { class: "hint", text: "Sub-agents appear here when Mnemo splits a task. Limits are under Settings → Agents." }));
  return root;
}

function agentRow(n: RosterNode, depth: number): HTMLElement {
  return h(
    "div",
    { class: `agent ${n.status}`, style: `margin-left:${depth * 16}px` },
    h("div", { class: "arow" }, h("span", { class: `dot ${n.status}` }), h("strong", { text: n.label }), h("span", { class: "chip dim", text: n.kind === "root" ? "main" : n.access }), h("span", { class: "chip", text: n.status }), n.woken && h("span", { class: "chip dim", text: "woken" })),
    n.task && h("div", { class: "atask", text: n.task }),
    n.steps.length > 0 && h("ul", { class: "steps" }, ...n.steps.map((s) => h("li", { text: s }))),
    n.answer && h("details", {}, h("summary", { text: "Answer" }), h("div", { class: "text", text: n.answer })),
  );
}

function memoryPane(): HTMLElement {
  const root = h("div", { class: "pane" });
  const m = memoryView;
  if (!m) return root.appendChild(h("div", { class: "empty", text: "Loading memory…" })).parentElement!;
  if (!m.available) return root.appendChild(h("div", { class: "empty", text: "Memory is off: the memory sidecar was not found. Run `mnemo doctor` in a terminal to see where it looks." })).parentElement!;
  const search = h("input", { type: "search", placeholder: "Search memory", class: "feedback" });
  search.addEventListener("keydown", (e) => e.key === "Enter" && loadMemory(search.value.trim()));
  const remember = h("input", { type: "text", placeholder: "Tell Mnemo something to keep, e.g. we deploy with fly", class: "feedback" });
  remember.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !remember.value.trim()) return;
    send(`/remember ${remember.value.trim()}`);
    remember.value = "";
    setTimeout(() => loadMemory(""), 800);
  });
  root.append(search, remember);
  const facts = (title: string, items: { key: string; value: string }[] | undefined) => {
    root.append(h("h3", { text: title }));
    if (!items?.length) return root.append(h("div", { class: "empty", text: "Nothing yet." }));
    for (const f of items)
      root.append(
        h("div", { class: "fact" }, h("div", {}, h("strong", { text: f.key }), h("div", { class: "text", text: f.value })), h("button", { class: "link", text: "Forget", title: `/forget ${f.key}`, onclick: () => (send(`/forget ${f.key}`), setTimeout(() => loadMemory(""), 800)) })),
      );
  };
  if (m.hits?.length) {
    root.append(h("h3", { text: "Search results" }));
    for (const hit of m.hits) root.append(h("div", { class: "fact" }, h("div", {}, h("strong", { text: hit.label }), h("div", { class: "hint", text: `${hit.kind} · ${hit.area} · ${hit.score.toFixed(2)}` }))));
  }
  facts("This project", m.project);
  facts("About you", m.user);
  return root;
}

function control(def: SettingDef, value: unknown): HTMLElement {
  const set = (v: unknown) => cmd({ type: "setSetting", key: def.key, value: v });
  switch (def.kind) {
    case "bool": {
      const box = h("input", { type: "checkbox", checked: !!value, "aria-label": def.label });
      box.addEventListener("change", () => set(box.checked));
      return box;
    }
    case "enum": {
      const sel = h("select", { "aria-label": def.label }, ...(def.options ?? []).map((o) => h("option", { value: o, text: o, selected: o === value })));
      sel.addEventListener("change", () => set(sel.value));
      return sel;
    }
    case "int":
    case "number": {
      const inp = h("input", { type: "number", value: String(value), min: def.min, max: def.max, step: def.kind === "int" ? 1 : "any", "aria-label": def.label });
      inp.addEventListener("change", () => set(inp.value === "" ? NaN : Number(inp.value)));
      return h("span", { class: "num" }, inp, def.unit && h("span", { class: "dim", text: def.unit }));
    }
    default: {
      const inp = h("input", { type: "text", value: String(value ?? ""), "aria-label": def.label });
      inp.addEventListener("change", () => set(inp.value));
      return inp;
    }
  }
}

function settingsPane(): HTMLElement {
  const root = h("div", { class: "pane settings" });
  if (!state.defs) return root.appendChild(h("div", { class: "empty", text: "Waiting for Mnemo…" })).parentElement!;
  root.append(h("p", { class: "hint", text: "These are Mnemo's own settings (the same as /settings in a terminal), saved in ~/.mnemo/config.json. The VS Code settings for this extension are separate." }), h("button", { class: "link", text: "Open the extension's VS Code settings", onclick: () => vscode.postMessage({ type: "openSettings" }) }));
  // Look and Keys shape the terminal interface; they stay reachable, folded, after what applies everywhere.
  const terminalOnly = new Set(["Look", "Keys"]);
  const groups = [...state.defs.groups.filter((g) => !terminalOnly.has(g)), ...state.defs.groups.filter((g) => terminalOnly.has(g))];
  for (const group of groups) {
    const items = state.defs.items.filter((d) => d.group === group);
    if (!items.length) continue;
    const sec = h("details", { class: "group", open: !terminalOnly.has(group) }, h("summary", { text: terminalOnly.has(group) ? `${group} (terminal interface)` : group }));
    for (const def of items) {
      const value = state.settings[def.key];
      sec.append(
        h(
          "div",
          { class: "setting" },
          h("div", { class: "slabel" }, h("strong", { text: def.label }), def.restart && h("span", { class: "chip dim", text: "next launch" }), h("div", { class: "hint", text: def.help })),
          h("div", { class: "sctl" }, control(def, value), value !== def.default && h("button", { class: "link", text: "Reset", title: `Back to ${String(def.default)}`, onclick: () => cmd({ type: "resetSetting", key: def.key }) })),
        ),
      );
    }
    root.append(sec);
  }
  return root;
}

// ---- chat ----

let composer: HTMLTextAreaElement;
let renderedCommitted = 0;
let renderedReset = -1;
let transcript: HTMLElement;
let committedEl: HTMLElement;
let liveEl: HTMLElement;
let suggestions: HTMLElement;
let selectedSuggestion = 0;

function growComposer(): void {
  composer.style.height = "auto";
  composer.style.height = `${Math.min(composer.scrollHeight, 200)}px`;
}

function updateSuggestions(): void {
  const matches = matchCommands(state.commands, composer.value);
  selectedSuggestion = Math.min(selectedSuggestion, Math.max(0, matches.length - 1));
  suggestions.replaceChildren(
    ...matches.map((c, i) =>
      h("button", { class: `sugg${i === selectedSuggestion ? " on" : ""}`, onmousedown: (e: Event) => (e.preventDefault(), accept(c.name)) }, h("strong", { text: `/${c.name}` }), h("small", { text: c.description })),
    ),
  );
  suggestions.hidden = matches.length === 0;
}

function accept(name: string): void {
  composer.value = `/${name} `;
  growComposer();
  updateSuggestions();
  composer.focus();
}

function submit(): void {
  const text = composer.value.trim();
  if (!text) return;
  history.unshift(text);
  historyAt = -1;
  send(text);
  composer.value = "";
  growComposer();
  updateSuggestions();
}

function buildChat(): HTMLElement {
  transcript = h("div", { class: "transcript", role: "log", "aria-live": "polite" }, (committedEl = h("div")), (liveEl = h("div")));
  suggestions = h("div", { class: "suggestions", hidden: true });
  composer = h("textarea", { rows: 1, placeholder: "Ask Mnemo… (/ for commands, Enter to send, Shift+Enter for a new line)", "aria-label": "Message Mnemo" });
  composer.addEventListener("input", () => (growComposer(), updateSuggestions()));
  composer.addEventListener("keydown", (e) => {
    const matches = matchCommands(state.commands, composer.value);
    if (matches.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        selectedSuggestion = (selectedSuggestion + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
        updateSuggestions();
        return e.preventDefault();
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && composer.value !== `/${matches[selectedSuggestion]!.name}`)) {
        e.preventDefault();
        return accept(matches[selectedSuggestion]!.name);
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && composer.value === "" && history.length) {
      historyAt = Math.min(historyAt + 1, history.length - 1);
      composer.value = history[historyAt]!;
      e.preventDefault();
    } else if (e.key === "Escape" && state.working) cmd({ type: "interrupt" });
  });
  return h("div", { class: "chat" }, transcript, h("div", { id: "dock" }), suggestions, h("div", { class: "composer" }, composer, h("button", { id: "sendbtn", class: "primary", text: "Send", onclick: submit })));
}

function renderChat(): void {
  const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  if (renderedReset !== state.resetSeq || state.committed.length < renderedCommitted) {
    committedEl.replaceChildren();
    renderedCommitted = 0;
    renderedReset = state.resetSeq;
  }
  for (let i = renderedCommitted; i < state.committed.length; i++) committedEl.append(blockEl(state.committed[i]!));
  renderedCommitted = state.committed.length;
  liveEl.replaceChildren(...state.live.map(blockEl));
  if (state.working) liveEl.append(h("div", { class: "working", text: `Working… ${Math.max(0, Math.round((Date.now() - state.working.since) / 1000))}s` }));
  if (state.queue.length) liveEl.append(h("div", { class: "queue" }, h("strong", { text: "Queued" }), ...state.queue.map((q) => h("div", { class: "text", text: q }))));
  if (stick) transcript.scrollTop = transcript.scrollHeight;

  const dock = document.getElementById("dock")!;
  const kids: Node[] = [];
  if (!state.hasModel && state.ready && host.running)
    kids.push(h("div", { class: "banner" }, h("span", { text: "No model is set up yet. Type /login to add a provider." }), h("button", { class: "link", text: "/login", onclick: () => send("/login") })));
  if (pendingYolo)
    kids.push(
      h(
        "div",
        { class: "dialog approval" },
        h("div", { class: "dtitle", text: "Bypass all approvals?" }),
        h("div", { class: "reason", text: "Mnemo will run commands and edit files without asking. Deny rules in permissions.json still apply. This lasts for this session only." }),
        h("div", { class: "buttons" }, h("button", { class: "danger", text: "Bypass approvals", onclick: () => ((pendingYolo = false), cmd({ type: "setMode", mode: "yolo" }), render()) }), h("button", { class: "primary", text: "Keep asking", onclick: () => ((pendingYolo = false), render()) })),
      ),
    );
  if (state.dialog) kids.push(dialogEl(state.dialog));
  dock.replaceChildren(...kids);
  const btn = document.getElementById("sendbtn")!;
  btn.textContent = state.working ? "Queue" : "Send";
}

// ---- frame ----

let appRoot: HTMLElement;
let problemEl: HTMLElement;
let headerEl: HTMLElement;
let tabsEl: HTMLElement;
let panes: Record<Tab, HTMLElement>;
let lastDialogKey = "";
let scheduled = false;

function render(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    paint();
  });
}

function paint(): void {
  const next = header();
  headerEl.replaceChildren(...next.childNodes);
  problemEl.replaceChildren(
    ...(host.problem || state.problem
      ? [
          h(
            "div",
            { class: "banner error", role: "alert" },
            h("span", { text: state.problem ?? host.problem }),
            h("button", { class: "link", text: "Dismiss", onclick: () => ((state = { ...state, problem: undefined }), (host.problem = undefined), render()) }),
            !host.running && h("button", { class: "link", text: "Restart", onclick: () => vscode.postMessage({ type: "restart" }) }),
          ),
        ]
      : []),
  );
  tabsEl.replaceChildren(
    ...(["chat", "agents", "memory", "settings"] as Tab[]).map((t) => {
      const badge = t === "chat" && state.dialog?.kind === "approval" ? "●" : t === "agents" && state.roster.length > 1 ? String(state.roster.length - 1) : "";
      return h("button", { role: "tab", "aria-selected": String(t === tab), class: t === tab ? "on" : "", onclick: () => setTab(t) }, t[0]!.toUpperCase() + t.slice(1), badge && h("span", { class: "badge", text: badge }));
    }),
  );
  for (const t of Object.keys(panes) as Tab[]) panes[t].hidden = t !== tab;
  renderChat();
  if (tab === "agents") panes.agents.replaceChildren(agentsView());
  if (tab === "memory") panes.memory.replaceChildren(memoryPane());
  if (tab === "settings" && !panes.settings.contains(document.activeElement)) panes.settings.replaceChildren(settingsPane());
  const key = state.dialog ? `${state.dialog.id}` : "";
  if (key && key !== lastDialogKey && state.dialog?.kind === "approval") (document.querySelector(".dialog.approval") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
  lastDialogKey = key;
}

function mount(): void {
  appRoot = document.getElementById("app")!;
  headerEl = h("div", { class: "header-wrap" });
  problemEl = h("div", { class: "problem" });
  tabsEl = h("div", { class: "tabs", role: "tablist" });
  panes = { chat: buildChat(), agents: h("div", { class: "tabpane" }), memory: h("div", { class: "tabpane" }), settings: h("div", { class: "tabpane" }) };
  appRoot.append(headerEl, problemEl, tabsEl, panes.chat, panes.agents, panes.memory, panes.settings);
  setInterval(() => state.working && render(), 1000);
}

window.addEventListener("message", (e) => {
  const m = e.data;
  switch (m?.type) {
    case "config":
      theme = String(m.theme);
      applyTheme();
      break;
    case "snapshot":
      theme = String(m.theme ?? "editor");
      applyTheme();
      state = m.state as State;
      host = { running: m.running, problem: m.problem, version: m.version };
      renderedReset = -1;
      break;
    case "event":
      state = reduce(state, m.event as RpcEvent);
      break;
    case "host":
      host.running = m.running;
      host.problem = m.problem;
      break;
    case "response":
      memoryWaiting.get(m.key)?.(m.result);
      memoryWaiting.delete(m.key);
      return;
    case "prefill":
      tab = "chat";
      composer.value = String(m.text);
      growComposer();
      updateSuggestions();
      composer.focus();
      break;
    case "tab":
      return setTab(m.tab as Tab);
  }
  render();
});

mount();
vscode.postMessage({ type: "ready" });
