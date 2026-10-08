/** Credential shapes that must never reach memory or a log. */
const SECRET = /(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g;

export function redact(s: string): string {
  return s.replace(SECRET, "[redacted]");
}
