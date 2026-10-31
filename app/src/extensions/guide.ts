/**
 * When to reach for Mnemo's own tools, said in the system prompt. A tool's description is read
 * when the model is already choosing a tool; pi's prompt lists only the tools that have a
 * snippet (read, bash, edit, write) and its rules say "use bash for ls, rg, find", so the code
 * index, memory and skills went unused unless the user named them. Here each active Mnemo
 * tool gets its line in the tool list, and a `working` section says when to use them without
 * being asked: structure before text, memory before exploring, a failure turned into a lesson.
 *
 * Only tools that are active are named (a read-only sub-agent has no memory_remember; with the
 * code index off there is no code_search), and the text is static, so the cached prompt
 * changes only when the tools do. Before mnemo-memory, which builds on the rendered prompt.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SNIPPETS: Record<string, string> = {
  code_map: "A first look at the project: folders, sizes and the most-used definitions",
  code_search: "Find where a function, class or type is defined, by name or by words about it",
  code_symbol: "A definition's signature and source, or a file's outline",
  code_refs: "Who calls a definition (what a change can break), or what it calls",
  memory_search: "Search what earlier sessions learned about this project and user",
  session_search: "Search what was said and run in past sessions",
  memory_remember: "Keep a durable fact (convention, command, preference, pitfall) for later sessions",
  memory_steer: "Record that an approach failed or a memory was wrong, so it is trusted less",
  create_skill: "Save a multi-step procedure you worked out as a reusable skill",
  update_skill: "Fix a skill that proved wrong or incomplete",
  spawn_subagent: "Hand a self-contained task to a sub-agent that reports back",
  ipy_run: "Run Python in a persistent kernel; it can call many tools at once",
};

/** The `working` section for these active tools; undefined when none of Mnemo's are active. */
export function workingSection(active: readonly string[]): string | undefined {
  const has = (...names: string[]) => names.every((n) => active.includes(n));
  const lines: string[] = [];
  if (has("code_search"))
    lines.push(
      "- Code by structure first. In a project new to this conversation, start with code_map. To find where something is defined, use code_search, not grep; code_symbol shows it. Use grep or rg for text inside bodies, strings and non-code files.",
    );
  if (has("code_refs")) lines.push("- Before you change a definition's signature or behaviour, or remove or rename it, run code_refs on it and update the callers it names.");
  if (has("memory_search")) lines.push("- Before exploring a part of this project you know nothing about, memory_search it: an earlier session may have mapped it or hit its pitfalls.");
  if (has("memory_steer"))
    lines.push(
      "- When an approach you took turns out wrong, or something memory supplied misled you, call memory_steer with what went wrong and why, as soon as you know. Failed tool calls are recorded by themselves; this is for the mistakes they do not show.",
    );
  if (has("memory_remember"))
    lines.push("- When you get past a failure, memory_remember the fix under a key naming the problem, so the next session does not repeat it.");
  if (has("create_skill", "update_skill"))
    lines.push(
      "- When you worked out a procedure of several steps that this project will need again (a release, a migration, a test setup), save it with create_skill. When a skill you followed was wrong or incomplete, fix it with update_skill.",
    );
  if (has("spawn_subagent"))
    lines.push(
      "- Your context is finite. For broad reading (surveying a large codebase, comparing many files), hand a read-only sub-agent (spawn_subagent) a complete brief and keep its answer instead of the files; start independent ones together.",
    );
  if (!lines.length) return undefined;
  return ["Mnemo gives you tools beyond reading and editing. Use them when they fit, without waiting to be asked:", ...lines].join("\n");
}

export function guideExtension() {
  return (pi: ExtensionAPI): void => {
    pi.on("before_agent_start", (event) => {
      const o = event.systemPromptOptions;
      const active = o.selectedTools.filter((n) => !o.hiddenTools.includes(n));
      for (const name of active) if (SNIPPETS[name] && !o.toolSnippets[name]) o.toolSnippets[name] = SNIPPETS[name];
      const working = workingSection(active);
      if (working) o.sections.working = working;
    });
  };
}
