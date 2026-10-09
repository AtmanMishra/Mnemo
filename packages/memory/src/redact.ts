/**
 * Credential shapes that must never reach memory, a log, or a reflection
 * model. Transcripts from other agents carry whatever a person pasted into
 * them, so this runs on everything memory reads, not only what it writes.
 */
const SECRET = new RegExp(
  [
    // Credentials in the shapes people paste: headers, URLs with a password, assignments.
    "\\bBearer\\s+[A-Za-z0-9._~+/=-]{16,}",
    "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}", // JWT
    "\\b[a-z][a-z0-9+.-]{1,12}://[^\\s:/@]+:[^\\s/@]+@", // scheme://user:password@
    "\\b(?:[A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|api[_-]?key|access[_-]?key)[A-Za-z0-9_]*)[\"']?\\s*[:=]\\s*[\"']?[^\\s\"',;]{6,}",
    "--(?:password|passwd|token|secret|api-key)[= ]\\S{6,}",
    "glpat-[A-Za-z0-9_-]{16,}",
    "SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}",
    "npm_[A-Za-z0-9]{30,}",
    "sk-ant-[A-Za-z0-9_-]{12,}",
    "sk-[A-Za-z0-9_-]{12,}",
    "\\b[a-z]{1,8}_sk_[A-Za-z0-9_-]{16,}", // oc_sk_… (OpenCode) and the like
    "\\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}", // Stripe-style
    "AKIA[0-9A-Z]{16}",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "xox[abprs]-[A-Za-z0-9-]{10,}",
    "AIza[0-9A-Za-z_-]{30,}",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]{0,8192}?-----END [A-Z ]*PRIVATE KEY-----",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\\s]{0,8192}", // cut off before its END line
  ].join("|"),
  "gi",
);

/** Zero-width and format characters: a key with one inside it is still a key. */
const INVISIBLE = /[\p{Cf}\u034f\u180e\ufe00-\ufe0f\u{E0000}-\u{E007F}]/gu;

export function redact(s: string): string {
  return s.replace(INVISIBLE, "").replace(SECRET, "[redacted]");
}
