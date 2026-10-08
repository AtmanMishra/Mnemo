/**
 * The glue between pi's session runtime and the interface.
 *
 * It owns the transcript, the dialog queue and the small amount of chrome state
 * (footer, extension statuses, working message), and it is the only place that
 * calls into the session. The Ink components read snapshots and call methods
 * here; nothing in `ui/` imports pi. That split is what lets a whole turn be
 * tested with a faux model and no terminal.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager, type AgentSession, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";
import { Transcript } from "../ui/store.ts";
import { Dialogs, type Choice } from "./dialogs.ts";
import { createUiContext } from "./ui-context.ts";
import { CYCLE, type Host, type MemoryNote, type Mode } from "../extensions/host.ts";
import { projectIdentity } from "@mnemo/memory";

export interface CommandInfo {
  name: string;
  description: string;
  source: "builtin" | "extension" | "prompt" | "skill";
}

export interface Footer {
  model: string;
  thinking: string;
  contextPercent: number | null;
  cost: number;
  cwd: string;
  branch?: string;
  mode: Mode;
  /** null when the memory sidecar is not installed. */
  memory: { nodes: number } | null;
}

export interface Chrome {
  footer: Footer;
  statuses: readonly [string, string][];
  workingMessage?: string;
  workingVisible: boolean;
  expanded: boolean;
  /** Set when something outside the input (an extension, a command) replaces the draft. */
  draftRequest?: { text: string; seq: number };
}

const BUILTINS: Omit<CommandInfo, "source">[] = [
  { name: "help", description: "commands and keys" },
  { name: "model", description: "choose the model" },
  { name: "thinking", description: "set how hard the model thinks" },
  { name: "login", description: "add a provider (API key or subscription)" },
  { name: "logout", description: "remove a provider's credentials" },
  { name: "new", description: "start a fresh session" },
  { name: "resume", description: "continue an earlier session in this folder" },
  { name: "compact", description: "summarise the conversation to free context" },
  { name: "cost", description: "tokens and spend for this session" },
  { name: "clear", description: "clear the screen (the session is kept)" },
  { name: "memory", description: "what Mnemo remembers · /memory <words> searches it" },
  { name: "remember", description: "tell Mnemo something to keep: /remember we deploy with fly" },
  { name: "forget", description: "retire a remembered fact: /forget package manager" },
  { name: "mode", description: "how much Mnemo may do without asking (default, accept-edits, plan, yolo)" },
  { name: "plan", description: "toggle plan mode (read-only)" },
  { name: "skills", description: "the skills Mnemo can load" },
  { name: "reload", description: "reload skills, prompts and extensions" },
  { name: "quit", description: "leave Mnemo" },
];

export const HELP_TEXT = [
  "Commands",
  ...BUILTINS.map((c) => `  /${c.name.padEnd(10)} ${c.description}`),
  "  /skill:name  run a skill · /<template> run a prompt template",
  "",
  "Keys",
  "  enter send (queues while Mnemo works) · alt+enter newline · esc interrupt",
  "  ↑/↓ history · tab accept suggestion · @ mention a file · shift+tab mode · ctrl+t thinking level",
  "  ctrl+o expand output · ctrl+l clear screen · ctrl+c twice / ctrl+d quit",
].join("\n");

function gitBranch(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    try {
      const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
      return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 7);
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return undefined;
      dir = up;
    }
  }
}

/** Thrown when the user backs out of a login prompt; reported as a choice, not a failure. */
class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Controller {
  readonly transcript: Transcript;
  readonly dialogs = new Dialogs();
  private chrome: Chrome;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private draft = "";
  private draftSeq = 0;
  private statuses = new Map<string, string>();
  private branch: string | undefined;
  private memoryNodes: number | null = null;
  private needsReload = false;

  constructor(
    readonly runtime: AgentSessionRuntime,
    private readonly options: { exit: (code?: number) => void; onClearScreen?: () => void; now?: () => number; host?: Host },
  ) {
    this.transcript = new Transcript({ now: options.now });
    this.branch = gitBranch(runtime.cwd);
    const host = options.host;
    if (host) {
      host.ui = {
        approve: (request, signal) => this.dialogs.approval(request, signal),
        note: (n) => this.note(n),
        resourcesChanged: () => {
          this.needsReload = true;
        },
      };
      void this.refreshMemory();
    }
    this.chrome = { footer: this.readFooter(), statuses: [], workingVisible: true, expanded: false };
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  /**
   * Whether a turn can run. With no credentials pi still reports a placeholder
   * model (provider "unknown"), so a model alone is not enough: its provider
   * must have auth.
   */
  get hasModel(): boolean {
    const m = this.runtime.session.model;
    if (!m) return false;
    try {
      return this.runtime.session.modelRuntime.hasConfiguredAuth(m.provider);
    } catch {
      return false;
    }
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  snapshot = (): Chrome => this.chrome;

  private update(patch: Partial<Chrome>): void {
    this.chrome = { ...this.chrome, ...patch };
    for (const l of this.listeners) l();
  }

  private readFooter(): Footer {
    const s = this.runtime.session;
    let percent: number | null = null;
    let cost = 0;
    try {
      const stats = s.getSessionStats();
      cost = stats.cost;
      percent = stats.contextUsage?.percent ?? null;
    } catch {
      // Stats are best effort; a fresh session with no model has none.
    }
    return {
      model: this.hasModel && s.model ? s.model.id : "no model",
      thinking: this.hasModel && s.supportsThinking() ? s.thinkingLevel : "",
      contextPercent: percent,
      cost,
      cwd: this.runtime.cwd,
      branch: this.branch,
      mode: this.options.host?.mode ?? "default",
      memory: this.memoryNodes === null ? null : { nodes: this.memoryNodes },
    };
  }

  private refreshFooter(): void {
    this.update({ footer: this.readFooter() });
  }

  /** Bind to the current session: events, extension UI. Called again after /new and /resume. */
  async bind(): Promise<void> {
    this.runtime.setRebindSession(async () => this.attach());
    await this.attach();
  }

  private async attach(): Promise<void> {
    this.unsubscribe?.();
    const session = this.runtime.session;
    await session.bindExtensions({
      uiContext: createUiContext(this.dialogs, {
        notify: (m, tone) => this.transcript.notice(m, tone),
        setStatus: (key, text) => {
          if (text === undefined) this.statuses.delete(key);
          else this.statuses.set(key, text);
          this.update({ statuses: [...this.statuses] });
        },
        setWorkingMessage: (m) => this.update({ workingMessage: m }),
        setWorkingVisible: (v) => this.update({ workingVisible: v }),
        setTitle: (t) => process.stdout.isTTY && process.stdout.write(`\x1b]0;${t}\x07`),
        getDraft: () => this.draft,
        setDraft: (text) => this.setDraft(text),
        getToolsExpanded: () => this.chrome.expanded,
        setToolsExpanded: (expanded) => this.update({ expanded }),
      }),
      mode: "tui",
      commandContextActions: {
        waitForIdle: () => this.runtime.session.waitForIdle(),
        newSession: (o) => this.runtime.newSession(o),
        fork: (id, o) => this.runtime.fork(id, o),
        navigateTree: (id, o) => this.runtime.session.navigateTree(id, o),
        switchSession: (p, o) => this.runtime.switchSession(p, o),
        reload: () => this.runtime.session.reload(),
      },
      shutdownHandler: () => this.quit(),
      onError: (e) => this.transcript.notice(`extension ${e.extensionPath}: ${e.error}`, "error"),
    });
    this.unsubscribe = session.subscribe((event) => {
      this.transcript.apply(event);
      if (
        event.type === "message_end" ||
        event.type === "agent_settled" ||
        event.type === "thinking_level_changed" ||
        event.type === "compaction_end"
      )
        this.refreshFooter();
      if (event.type === "agent_settled") void this.afterRun();
    });
    this.refreshFooter();
  }

  /** What is in the input right now. */
  get draftText(): string {
    return this.draft;
  }

  /** The input reports its text so extensions can read it. */
  reportDraft(text: string): void {
    this.draft = text;
  }

  setDraft(text: string): void {
    this.draft = text;
    this.update({ draftRequest: { text, seq: ++this.draftSeq } });
  }

  toggleExpanded(): void {
    this.update({ expanded: !this.chrome.expanded });
  }

  /** Everything the slash menu can offer, built-ins first. */
  commands(): CommandInfo[] {
    const out: CommandInfo[] = BUILTINS.map((c) => ({ ...c, source: "builtin" as const }));
    const s = this.runtime.session;
    try {
      for (const c of s.extensionRunner.getRegisteredCommands())
        out.push({ name: c.invocationName, description: c.description ?? "", source: "extension" });
    } catch {
      // No extension runner before the first bind.
    }
    for (const t of s.promptTemplates) out.push({ name: t.name, description: t.description ?? "prompt template", source: "prompt" });
    for (const k of s.resourceLoader.getSkills().skills)
      out.push({ name: `skill:${k.name}`, description: k.description ?? "skill", source: "skill" });
    return out;
  }

  /** Send what the user typed: a built-in command, or a prompt for pi. */
  async submit(text: string, mode: "auto" | "steer" = "auto"): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/")) {
      const [name = "", ...rest] = trimmed.slice(1).split(/\s+/);
      if (await this.builtin(name, rest.join(" "))) return;
    }
    const session = this.runtime.session;
    if (!this.hasModel) {
      this.transcript.notice("No model is configured yet — run /login to add a provider, then /model.", "warn");
      return;
    }
    try {
      if (session.isStreaming) await session.prompt(trimmed, { streamingBehavior: mode === "steer" ? "steer" : "followUp" });
      else await session.prompt(trimmed);
    } catch (error) {
      this.transcript.notice(errorText(error), "error");
    }
  }

  interrupt(): void {
    void this.runtime.session.abort().catch(() => {});
  }

  async quit(code = 0): Promise<void> {
    this.dialogs.cancelAll();
    this.unsubscribe?.();
    try {
      await this.runtime.dispose();
    } finally {
      this.options.exit(code);
    }
  }

  private note(n: MemoryNote): void {
    switch (n.kind) {
      case "recall":
        this.transcript.memory("Recalled", n.items, { afterNextUser: true });
        break;
      case "learned":
        this.transcript.memory(`Learned ${n.items.length === 1 ? "a fact" : `${n.items.length} facts`}`, n.items);
        void this.refreshMemory();
        break;
      case "steer":
        this.transcript.memory(`Memory ${n.text}`);
        break;
      case "skill":
        this.transcript.memory(n.text[0]!.toUpperCase() + n.text.slice(1));
        break;
      case "session":
        this.transcript.memory(n.text, n.items);
        break;
      case "failed":
        this.transcript.push({ kind: "notice", tone: "warn", text: n.text });
        break;
    }
  }

  private async refreshMemory(): Promise<void> {
    const stats = await this.options.host?.memory?.stats();
    this.memoryNodes = stats ? stats.nodes : null;
    this.refreshFooter();
  }

  /** Once a run settles: pick up skills written during it, refresh the counts. */
  private async afterRun(): Promise<void> {
    if (this.needsReload) {
      this.needsReload = false;
      try {
        await this.runtime.session.reload();
      } catch (error) {
        this.transcript.notice(`could not reload skills: ${errorText(error)}`, "warn");
      }
    }
    void this.refreshMemory();
  }

  get mode(): Mode {
    return this.options.host?.mode ?? "default";
  }

  setMode(mode: Mode): void {
    const host = this.options.host;
    if (!host) return;
    host.mode = mode;
    this.refreshFooter();
  }

  /** shift+tab: default → accept edits → plan → default. */
  cycleMode(): void {
    const i = CYCLE.indexOf(this.mode);
    this.setMode(CYCLE[(i + 1) % CYCLE.length]!);
  }

  cycleThinking(): void {
    const level = this.runtime.session.cycleThinkingLevel();
    if (level) this.refreshFooter();
  }

  /** Returns true when `name` was a built-in and has been handled. */
  private async builtin(name: string, arg: string): Promise<boolean> {
    switch (name) {
      case "help":
        this.transcript.notice(HELP_TEXT);
        return true;
      case "quit":
      case "exit":
        await this.quit();
        return true;
      case "clear":
        this.options.onClearScreen?.();
        this.transcript.clear();
        return true;
      case "model":
        await this.chooseModel(arg);
        return true;
      case "thinking":
        await this.chooseThinking(arg);
        return true;
      case "login":
        await this.login(arg);
        return true;
      case "logout":
        await this.logout(arg);
        return true;
      case "new":
        await this.newSession();
        return true;
      case "resume":
        await this.resume();
        return true;
      case "compact":
        try {
          await this.runtime.session.compact(arg || undefined);
        } catch (error) {
          this.transcript.notice(errorText(error), "error");
        }
        return true;
      case "memory":
        await this.showMemory(arg);
        return true;
      case "remember": {
        const mem = this.options.host?.memory;
        if (!mem) return this.memoryOff(), true;
        if (!arg) {
          this.transcript.notice("Usage: /remember <something true about this project>", "warn");
          return true;
        }
        const key = arg.split(/[:=]/)[0]!.trim().toLowerCase().slice(0, 40);
        const value = arg.includes(":") || arg.includes("=") ? arg.slice(arg.search(/[:=]/) + 1).trim() : arg;
        await mem.learn("project", this.projectId, arg.includes(":") || arg.includes("=") ? key : `note ${Date.now().toString(36)}`, value);
        this.transcript.memory("Remembered", [value]);
        void this.refreshMemory();
        return true;
      }
      case "forget": {
        const mem = this.options.host?.memory;
        if (!mem) return this.memoryOff(), true;
        if (!arg) {
          this.transcript.notice("Usage: /forget <key> — the key as /memory shows it, e.g. /forget package manager", "warn");
          return true;
        }
        const ok = (await mem.forget("project", this.projectId, arg)) || (await mem.forget("user", this.projectId, arg));
        this.transcript.memory(ok ? `Forgot "${arg}"` : `Nothing called "${arg}" in this project's or your profile`, ok ? ["kept as history, never recalled again"] : []);
        void this.refreshMemory();
        return true;
      }
      case "mode": {
        const modes: Mode[] = ["default", "accept-edits", "plan", "yolo"];
        const pick =
          (modes.find((m) => m === arg) as Mode | undefined) ??
          ((await this.dialogs.select("Mode", [
            { value: "default", label: "default", description: "ask before edits and commands" },
            { value: "accept-edits", label: "accept edits", description: "edit project files freely, ask before commands" },
            { value: "plan", label: "plan", description: "read-only: nothing is changed" },
            { value: "yolo", label: "yolo", description: "ask for nothing (deny rules still hold)" },
          ])) as Mode | undefined);
        if (pick) {
          this.setMode(pick);
          this.transcript.notice(`Mode: ${pick}`);
        }
        return true;
      }
      case "plan":
        this.setMode(this.mode === "plan" ? "default" : "plan");
        this.transcript.notice(this.mode === "plan" ? "Plan mode: Mnemo reads and proposes, and changes nothing" : "Plan mode off");
        return true;
      case "skills": {
        const skills = this.runtime.session.resourceLoader.getSkills().skills;
        this.transcript.notice(
          skills.length
            ? ["Skills", ...skills.map((k) => `  /skill:${k.name.padEnd(24)} ${k.description ?? ""}`)].join("\n")
            : "No skills yet. Mnemo writes one when it works out a procedure worth keeping, or add SKILL.md files under ~/.mnemo/agent/skills.",
        );
        return true;
      }
      case "reload":
        await this.runtime.session.reload();
        this.transcript.notice("Reloaded skills, prompts and extensions");
        return true;
      case "cost": {
        const st = this.runtime.session.getSessionStats();
        this.transcript.notice(
          `${st.tokens.input.toLocaleString()} in · ${st.tokens.output.toLocaleString()} out · ` +
            `${st.tokens.cacheRead.toLocaleString()} cached · $${st.cost.toFixed(4)} · ${st.toolCalls} tool calls`,
        );
        return true;
      }
      default:
        return false;
    }
  }

  private projectIdCache: string | undefined;

  /** This folder's project identity (git remote, else repo root, else the folder). */
  private get projectId(): string {
    return (this.projectIdCache ??= projectIdentity(this.runtime.cwd).id);
  }

  private memoryOff(): void {
    this.transcript.notice("Memory is off: the memsrv sidecar was not found. `mnemo doctor` says where it looks.", "warn");
  }

  private async showMemory(query: string): Promise<void> {
    const mem = this.options.host?.memory;
    if (!mem) return this.memoryOff();
    const id = this.projectId;
    if (query) {
      const hits = await mem.search(query, 6, await mem.project(id));
      this.transcript.memory(
        hits.length ? `Memory for "${query}"` : `Nothing in memory matches "${query}"`,
        hits.map((h) => `${h.label} [${h.area}]`),
      );
      return;
    }
    const [stats, project, user] = await Promise.all([mem.stats(), mem.profile("project", id), mem.profile("user", id)]);
    const areas = stats ? Object.entries(stats.byArea).map(([a, n]) => `${a.toLowerCase()} ${n}`).join(" · ") : "";
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    this.transcript.memory(`Memory · ${plural(stats?.nodes ?? 0, "node")} · ${plural(stats?.episodes ?? 0, "episode")}${areas ? ` · ${areas}` : ""}`, [
      ...(project.length ? ["This project:", ...project.map((f) => `· ${f.key}: ${f.value}`)] : ["Nothing about this project yet."]),
      ...(user.length ? ["You:", ...user.map((f) => `· ${f.key}: ${f.value}`)] : []),
    ]);
  }

  private async chooseModel(arg: string): Promise<void> {
    const modelRuntime = this.runtime.session.modelRuntime;
    const available = await modelRuntime.getAvailable();
    if (available.length === 0) {
      this.transcript.notice("No models are available — /login to add a provider first.", "warn");
      return;
    }
    let pick = arg
      ? available.find((m) => m.id === arg || `${m.provider}/${m.id}` === arg)
      : undefined;
    if (!pick && arg) {
      this.transcript.notice(`No available model called ${arg}.`, "warn");
      return;
    }
    if (!pick) {
      const current = this.runtime.session.model;
      const isCurrent = (m: (typeof available)[number]) => current?.id === m.id && current?.provider === m.provider;
      const ordered = [...available].sort(
        (a, b) =>
          Number(isCurrent(b)) - Number(isCurrent(a)) ||
          a.provider.localeCompare(b.provider) ||
          (a.name ?? a.id).localeCompare(b.name ?? b.id),
      );
      const value = await this.dialogs.select(
        "Choose a model",
        ordered.map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: m.name ?? m.id,
          description: `${m.provider}${current && current.id === m.id && current.provider === m.provider ? " · current" : ""}`,
        })),
      );
      if (!value) return;
      pick = available.find((m) => `${m.provider}/${m.id}` === value);
    }
    if (!pick) return;
    try {
      await this.runtime.session.setModel(pick);
      this.transcript.notice(`Model set to ${pick.name ?? pick.id}`);
    } catch (error) {
      this.transcript.notice(errorText(error), "error");
    }
    this.refreshFooter();
  }

  private async chooseThinking(arg: string): Promise<void> {
    const session = this.runtime.session;
    const levels = session.getAvailableThinkingLevels();
    if (!session.supportsThinking() || levels.length === 0) {
      this.transcript.notice("This model has no thinking levels.", "warn");
      return;
    }
    const level =
      (arg && levels.find((l) => l === arg)) ||
      (await this.dialogs.select(
        "Thinking level",
        levels.map((l) => ({ value: l, label: l, description: l === session.thinkingLevel ? "current" : undefined })),
      ));
    if (!level) return;
    session.setThinkingLevel(level as (typeof levels)[number]);
    this.refreshFooter();
  }

  /** pi's own login flow (every provider pi knows, keys and OAuth), drawn with our dialogs. */
  private async login(arg: string): Promise<void> {
    const modelRuntime = this.runtime.session.modelRuntime;
    const providers = modelRuntime.getProviders().filter((p) => p.auth.apiKey?.login || p.auth.oauth);
    const choices: Choice[] = providers
      .map((p) => ({
        value: p.id,
        label: p.name,
        description: [p.auth.apiKey?.login && "API key", p.auth.oauth && "subscription"].filter(Boolean).join(" · "),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const id = arg || (await this.dialogs.select("Log in to a provider", choices));
    const provider = providers.find((p) => p.id === id);
    if (!provider) {
      if (id) this.transcript.notice(`Unknown provider ${id}.`, "warn");
      return;
    }
    let type: "api_key" | "oauth" = provider.auth.apiKey?.login ? "api_key" : "oauth";
    if (provider.auth.apiKey?.login && provider.auth.oauth) {
      const picked = await this.dialogs.select(`${provider.name}: how do you want to log in?`, [
        { value: "oauth", label: "Subscription", description: "sign in with your account" },
        { value: "api_key", label: "API key", description: "paste a key" },
      ]);
      if (!picked) return;
      type = picked as typeof type;
    }
    const abort = new AbortController();
    try {
      await modelRuntime.login(provider.id, type, {
        signal: abort.signal,
        prompt: (p: AuthPrompt) => this.authPrompt(p),
        notify: (e: AuthEvent) => this.authEvent(e),
      });
      this.transcript.notice(`Logged in to ${provider.name}.`);
      if (!this.hasModel) await this.chooseModel("");
    } catch (error) {
      if (error instanceof Cancelled || abort.signal.aborted) this.transcript.notice("Login cancelled");
      else this.transcript.notice(`Login failed: ${errorText(error)}`, "error");
    }
    this.refreshFooter();
  }

  private async authPrompt(p: AuthPrompt): Promise<string> {
    let answer: string | undefined;
    if (p.type === "select") {
      answer = await this.dialogs.select(
        p.message,
        p.options.map((o) => ({ value: o.id, label: o.label, description: o.description })),
        p.signal,
      );
    } else {
      answer = await this.dialogs.text(p.message, { placeholder: p.placeholder, secret: p.type === "secret", signal: p.signal });
    }
    if (answer === undefined) throw new Cancelled();
    return answer;
  }

  private authEvent(e: AuthEvent): void {
    if (e.type === "auth_url") this.transcript.notice(`Open this URL to sign in:\n${e.url}${e.instructions ? `\n${e.instructions}` : ""}`);
    else if (e.type === "device_code") this.transcript.notice(`Go to ${e.verificationUri} and enter the code ${e.userCode}`);
    else this.transcript.notice(e.message);
  }

  private async logout(arg: string): Promise<void> {
    const modelRuntime = this.runtime.session.modelRuntime;
    const creds = await modelRuntime.listCredentials();
    if (creds.length === 0) {
      this.transcript.notice("No stored credentials.");
      return;
    }
    const id =
      arg ||
      (await this.dialogs.select(
        "Remove which credentials?",
        creds.map((c) => ({ value: c.providerId, label: modelRuntime.getProvider(c.providerId)?.name ?? c.providerId, description: c.type })),
      ));
    if (!id) return;
    await modelRuntime.logout(id);
    this.transcript.notice(`Logged out of ${id}.`);
    this.refreshFooter();
  }

  private async newSession(): Promise<void> {
    const result = await this.runtime.newSession();
    if (result.cancelled) return;
    this.options.onClearScreen?.();
    this.transcript.clear();
    this.transcript.notice("New session");
  }

  private async resume(): Promise<void> {
    const sessions = await SessionManager.list(this.runtime.cwd);
    const current = this.runtime.session.sessionFile;
    const others = sessions.filter((s) => s.path !== current && s.messageCount > 0);
    if (others.length === 0) {
      this.transcript.notice("No earlier sessions in this folder.");
      return;
    }
    const pick = await this.dialogs.select(
      "Resume a session",
      others
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          value: s.path,
          label: (s.name ?? s.firstMessage ?? "untitled").replace(/\s+/g, " ").slice(0, 70),
          description: `${s.modified.toLocaleString()} · ${s.messageCount} messages`,
        })),
    );
    if (!pick) return;
    await this.resumePath(pick);
  }

  /** Continue the session stored at `file` (the workspace's Sessions pane, /resume). */
  async resumePath(file: string): Promise<void> {
    if (this.runtime.session.sessionFile === file) return;
    const result = await this.runtime.switchSession(file);
    if (result.cancelled) return;
    this.options.onClearScreen?.();
    this.transcript.clear();
    this.transcript.load(this.runtime.session.messages);
    this.transcript.notice("Resumed session");
  }
}
