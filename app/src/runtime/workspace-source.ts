/**
 * The workspace's data, from the running app: the project's files, what
 * memory holds about this project, pi's saved sessions here, the skills pi
 * loaded, and today's trace log.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { factsOf, factValue, projectIdentity } from "@mnemo/memory";
import type { Controller } from "./controller.ts";
import type { Host } from "../extensions/host.ts";
import { listFiles } from "../ui/files.ts";
import type { Item, Pane, Preview, PreviewLine, WorkspaceSource } from "../ui/workspace/model.ts";

const PREVIEW_LINES = 400;

function readPreview(file: string, rel: string): Preview {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (st.size > 2_000_000) return { title: rel, subtitle: `${(st.size / 1e6).toFixed(1)} MB — too large to preview`, lines: [] };
    const buf = fs.readFileSync(file);
    if (buf.subarray(0, 8000).includes(0)) return { title: rel, subtitle: "binary file", lines: [] };
    text = buf.toString("utf8");
  } catch (error) {
    return { title: rel, subtitle: `cannot read: ${(error as Error).message}`, lines: [] };
  }
  const all = text.split("\n");
  const lines: PreviewLine[] = all.slice(0, PREVIEW_LINES).map((t, i) => ({ text: t.replace(/\t/g, "  "), gutter: String(i + 1) }));
  if (all.length > PREVIEW_LINES) lines.push({ text: `… ${all.length - PREVIEW_LINES} more lines`, tone: "faint" });
  return { title: rel, subtitle: `${all.length} lines`, lines, hint: "i insert @file into the prompt" };
}

export function workspaceSource(controller: Controller, host: Host | undefined, home: string): WorkspaceSource {
  const cwd = controller.runtime.cwd;
  let files: string[] | undefined;
  const memory = host?.memory;
  const identity = projectIdentity(cwd);
  return {
    files: () => (files ??= listFiles(cwd)),

    async memory(): Promise<Item[]> {
      if (!memory) return [{ id: "off", label: "memory is off", detail: "memsrv not found — mnemo doctor", tone: "muted", kind: "head" }];
      const [project, user, nodes] = await Promise.all([memory.profile("project", identity.id), memory.profile("user", identity.id), memory.nodes()]);
      const items: Item[] = [];
      const head = (id: string, label: string, n: number) => items.push({ id, label, detail: String(n), kind: "head", tone: "link" });
      head("h:project", `This project`, project.length);
      for (const f of project) items.push({ id: `p:${f.key}`, label: f.key, detail: f.value, kind: "fact", depth: 1 });
      head("h:user", "You", user.length);
      for (const f of user) items.push({ id: `u:${f.key}`, label: f.key, detail: f.value, kind: "fact", depth: 1 });
      // Pitfalls with a fix, and recent sessions with a record: their state says which.
      const pitfalls: Item[] = [];
      const sessions: Item[] = [];
      for (const n of nodes.filter((x) => x.area === "Salience").slice(-40)) {
        const st = await memory.state(n.id);
        const fix = factValue(st, "fix");
        if (fix) pitfalls.push({ id: `n:${n.id}`, label: (factValue(st, "failure") ?? n.label.replace(/^pain: /, "")).slice(0, 80), detail: `fix: ${fix}`, kind: "pitfall", depth: 1, tone: "memory" });
      }
      for (const n of nodes.filter((x) => x.kind === "TaskEpisode").slice(-12).reverse()) {
        const st = await memory.state(n.id);
        const goal = factValue(st, "goal");
        if (goal) sessions.push({ id: `n:${n.id}`, label: goal.slice(0, 80), detail: factValue(st, "outcome"), kind: "session", depth: 1 });
      }
      head("h:pitfalls", "Pitfalls & fixes", pitfalls.length);
      items.push(...pitfalls);
      head("h:sessions", "Session records", sessions.length);
      items.push(...sessions);
      return items;
    },

    async sessions(): Promise<Item[]> {
      const list = await SessionManager.list(cwd).catch(() => []);
      const current = controller.runtime.session.sessionFile;
      return list
        .filter((s) => s.messageCount > 0)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .map((s) => ({
          id: s.path,
          label: (s.name ?? s.firstMessage ?? "untitled").replace(/\s+/g, " ").slice(0, 80),
          detail: `${s.modified.toLocaleDateString()} · ${s.messageCount} msgs${s.path === current ? " · now" : ""}`,
          kind: "session" as const,
          tone: s.path === current ? ("accent" as const) : undefined,
        }));
    },

    skills(): Item[] {
      return controller.runtime.session.resourceLoader
        .getSkills()
        .skills.map((k) => ({ id: k.filePath, label: k.name, detail: k.description, kind: "skill" as const }));
    },

    logs(): Item[] {
      const file = path.join(home, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`);
      let lines: string[] = [];
      try {
        lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-200).reverse();
      } catch {
        return [{ id: "none", label: "nothing logged today", kind: "head", tone: "muted" }];
      }
      return lines.flatMap((l, i): Item[] => {
        try {
          const r = JSON.parse(l) as { ts: string; type: string; tool?: string; subject?: string; ok?: boolean; ms?: number; model?: string; cost?: number; in?: number; out?: number };
          const at = r.ts.slice(11, 19);
          if (r.type === "tool")
            return [{ id: String(i), label: `${at} ${r.tool}`, detail: `${r.subject ?? ""}${r.ms !== undefined ? ` · ${r.ms}ms` : ""}`, kind: "log" as const, tone: r.ok === false ? ("fail" as const) : undefined }];
          return [{ id: String(i), label: `${at} turn`, detail: `${r.model ?? ""} · ${r.in ?? 0}→${r.out ?? 0} tok · $${(r.cost ?? 0).toFixed(4)}`, kind: "log" as const, tone: "muted" as const }];
        } catch {
          return [];
        }
      });
    },

    async preview(pane: Pane, id: string): Promise<Preview | undefined> {
      if (pane === "files") return fs.statSync(path.join(cwd, id), { throwIfNoEntry: false })?.isFile() ? readPreview(path.join(cwd, id), id) : undefined;
      if (pane === "skills") return { ...readPreview(id, path.basename(path.dirname(id))), hint: undefined };
      if (pane === "sessions") {
        const list = await SessionManager.list(cwd).catch(() => []);
        const s = list.find((x) => x.path === id);
        if (!s) return undefined;
        return {
          title: (s.name ?? s.firstMessage ?? "untitled").replace(/\s+/g, " ").slice(0, 100),
          subtitle: `${s.created.toLocaleString()} → ${s.modified.toLocaleString()} · ${s.messageCount} messages`,
          lines: s.allMessagesText.split("\n").slice(0, PREVIEW_LINES).map((text) => ({ text })),
          hint: "r resume this session",
        };
      }
      if (pane === "memory" && memory && id.startsWith("n:")) {
        const st = await memory.state(Number(id.slice(2)));
        const facts = factsOf(st, { internal: true });
        return { title: "memory", lines: facts.map((f) => ({ text: `${f.key}: ${f.value}`, tone: f.key === "fix" ? "memory" : "text" })) };
      }
      return undefined;
    },

    act(pane: Pane, id: string, key: string): void {
      if (pane === "sessions" && key === "r") void controller.resumePath(id);
      if (pane === "files" && key === "i") controller.setDraft(`${controller.draftText}@${id} `);
    },
  };
}
