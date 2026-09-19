/**
 * A keystroke becomes an answer.
 *
 * The prompt offers choices; this says which key means which, and — the part
 * that matters more — what happens when the key means nothing.
 *
 * Three rules, and the third is the one people get wrong:
 *
 *  1. **Every option is reachable by number.** The menu is short and ordered, so
 *     `1` is always the first thing offered; a reader who does not want to learn
 *     mnemonics never has to.
 *  2. **The letters are mnemonics, not a second menu**: `a` for allow once, `d`
 *     for deny, `o` for other, `esc` for the same as deny. Fewer things to
 *     remember than to read.
 *  3. **An unrecognised key does nothing.** It is not a default, not an
 *     approval, and not a refusal — a question that answers itself on a stray
 *     keypress is worse than one that requires a deliberate choice, and the
 *     safe default (deny) is only safe when it is *chosen*.
 */
import type { ApprovalChoice, ApprovalPrompt } from "./prompt.ts";

/** The choice a key selects, or undefined when the key means nothing here. */
export function choiceForKey(key: string, prompt: ApprovalPrompt): ApprovalChoice | undefined {
  const offers = (id: ApprovalChoice) => prompt.options.some((option) => option.id === id);

  // The control characters a terminal actually sends for Enter are checked
  // BEFORE normalising: `trim()` exists to strip exactly these, so a normalise-
  // then-match order turned the key everyone presses into the empty string.
  if (key === "\r" || key === "\n") return offers("once") ? "once" : undefined;

  const normalised = key.trim().toLowerCase();

  // A number picks the option in the order it was shown.
  const digit = /^([1-9])$/.exec(normalised);
  if (digit) {
    const option = prompt.options[Number(digit[1]) - 1];
    return option?.id;
  }

  switch (normalised) {
    case "enter":
    case "return":
    case "a":
      // Enter is the affirmative the reader is most likely to have meant when
      // the only way into the menu was already deliberate — and it is only
      // reachable while this very question is on screen.
      return prompt.options.some((option) => option.id === "once") ? "once" : undefined;
    case "d":
    case "n":
    case "escape":
    case "esc":
      return prompt.options.some((option) => option.id === "deny") ? "deny" : undefined;
    case "o":
      return prompt.options.some((option) => option.id === "other") ? "other" : undefined;
    default:
      return undefined;
  }
}

/**
 * What a keypress did, for the caller to act on.
 *
 * `answer` is a decision; `other` means the reader wants to type something;
 * `none` means the key was not about this question.
 */
export type KeyEffect =
  | { kind: "answer"; choice: ApprovalChoice }
  | { kind: "other" }
  | { kind: "none" };

export function effectOfKey(key: string, prompt: ApprovalPrompt): KeyEffect {
  const choice = choiceForKey(key, prompt);
  if (choice === undefined) return { kind: "none" };
  if (choice === "other") return { kind: "other" };
  return { kind: "answer", choice };
}

/** The keys as the interface shows them, derived from the options on offer. */
export function keyHints(prompt: ApprovalPrompt): string {
  return prompt.options
    .map((option, index) => {
      const shortcut = option.id === "deny" ? "d" : option.id === "other" ? "o" : option.id === "once" ? "a" : undefined;
      return shortcut ? `${index + 1}/${shortcut} ${option.label}` : `${index + 1} ${option.label}`;
    })
    .join("   ");
}
