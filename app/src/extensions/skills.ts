/**
 * Skills Mnemo writes for itself.
 *
 * pi already discovers and loads `SKILL.md` files; these tools let the agent
 * add to that set when it notices a procedure worth keeping, and improve one
 * that failed. A skill is a file a person can read and edit, under
 * the repository's `.agents/skills/<name>/SKILL.md` (or, for a personal one,
 * `$MNEMO_HOME/agent/skills/`), and also a node in memory
 * (Procedural), so a later session can recall that it exists and why.
 * Every update keeps the previous body under `$MNEMO_HOME/skill-history/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillsDir } from "../runtime/paths.ts";
import { projectIdentity, renderSkill, skillPath } from "@mnemo/memory";
import type { Host } from "./host.ts";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function skillFile(home: string, name: string): string {
  return path.join(skillsDir(home), name, "SKILL.md");
}

/** Where a skill goes: the repository's `.agents/skills/`, or Mnemo's home for a personal one. */
const target = (home: string, projectRoot: string, scope: "project" | "user", name: string) =>
  skillPath(scope, name, { projectRoot, userSkillsDir: skillsDir(home) });

export function skillsExtension(host: Host) {
  return (pi: ExtensionAPI): void => {
    pi.registerTool(
      defineTool({
        name: "create_skill",
        label: "Create skill",
        description:
          "Save a reusable procedure as a skill (a SKILL.md other sessions can load). Use it when you worked out a multi-step " +
          "procedure this project or user will need again. name: lowercase-with-dashes. description: when to use it (this is how it is found). " +
          "instructions: the steps, commands and pitfalls, in Markdown. scope: project (default; saved in the repository's " +
          ".agents/skills) or user (a personal skill for every project).",
        parameters: Type.Object({
          name: Type.String(),
          description: Type.String(),
          instructions: Type.String(),
          scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("user")])),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          if (!NAME.test(params.name)) throw new Error("name must be lowercase letters, digits and dashes");
          const file = target(host.home, projectIdentity(ctx.cwd).root, params.scope ?? "project", params.name);
          if (fs.existsSync(file)) throw new Error(`skill ${params.name} already exists — use update_skill`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, renderSkill(params.name, params.description, params.instructions));
          const node = await host.memory?.createNode("harness", `skill ${params.name}`, "procedural");
          if (node !== undefined) await host.memory?.fact(node, "use when", params.description);
          host.ui?.note({ kind: "skill", text: `created skill ${params.name}` });
          host.ui?.resourcesChanged();
          return { content: [{ type: "text", text: `Saved skill ${params.name} at ${file}. It is available as /skill:${params.name} from the next message.` }], details: { file } };
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "update_skill",
        label: "Update skill",
        description:
          "Improve an existing skill after it proved wrong or incomplete. Give the full new instructions and the reason; the old version is kept as history.",
        parameters: Type.Object({
          name: Type.String(),
          instructions: Type.String(),
          reason: Type.String({ description: "What went wrong with the old version" }),
          description: Type.Optional(Type.String()),
        }),
        async execute(_id, params, _signal, _update, ctx) {
          const root = projectIdentity(ctx.cwd).root;
          const file = [target(host.home, root, "project", params.name), skillFile(host.home, params.name)].find((f) => fs.existsSync(f));
          if (!file) throw new Error(`no skill ${params.name} in ${path.join(root, ".agents", "skills")} or ${skillsDir(host.home)}`);
          const old = fs.readFileSync(file, "utf8");
          const history = path.join(host.home, "skill-history", params.name);
          fs.mkdirSync(history, { recursive: true });
          fs.writeFileSync(path.join(history, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`), old);
          const description = params.description ?? /description:\s*(.*)/.exec(old)?.[1]?.replace(/^"|"$/g, "") ?? params.name;
          fs.writeFileSync(file, renderSkill(params.name, description, params.instructions));
          const hits = await host.memory?.search(`skill ${params.name}`, 3);
          const node = hits?.find((h) => h.label === `skill ${params.name}`)?.node;
          if (node !== undefined) await host.memory?.fact(node, "last change", params.reason);
          host.ui?.note({ kind: "skill", text: `updated skill ${params.name}: ${params.reason}` });
          host.ui?.resourcesChanged();
          return { content: [{ type: "text", text: `Updated ${params.name}; the previous version is in ${history}.` }], details: { file } };
        },
      }),
    );
  };
}
