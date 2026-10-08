/**
 * Credential shapes that must never reach memory, a log, or a reflection
 * model. Transcripts from other agents carry whatever a person pasted into
 * them, so this runs on everything memory reads, not only what it writes.
 */
const SECRET = new RegExp(
  [
    "sk-ant-[A-Za-z0-9_-]{12,}",
    "sk-[A-Za-z0-9_-]{12,}",
    "\\b[a-z]{1,8}_sk_[A-Za-z0-9_-]{16,}", // oc_sk_… (OpenCode) and the like
    "\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}", // Stripe-style
    "AKIA[0-9A-Z]{16}",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "xox[abprs]-[A-Za-z0-9-]{10,}",
    "AIza[0-9A-Za-z_-]{30,}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----",
  ].join("|"),
  "g",
);

export function redact(s: string): string {
  return s.replace(SECRET, "[redacted]");
}
