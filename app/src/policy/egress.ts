/**
 * Where a call would connect, for `net` rules and the default block on cloud metadata.
 *
 * A cloud machine's metadata service (169.254.169.254 and friends) hands out the machine's
 * credentials to anyone who asks from inside it, so a prompt-injected `curl` there is a
 * credential theft. It is refused by default in every mode; an `allow` rule for the host
 * (`{"tool": "net", "pattern": "169.254.169.254", "action": "allow"}`) opens it.
 *
 * Reading hosts out of a command line is a filter, like the rest of the gate: it finds URLs,
 * `user@host:` remotes, the operands of network programs and address literals in any spelling
 * (`2852039166`, `0xa9fea9fe`, `[::ffff:169.254.169.254]`), not a name that a script builds or a
 * DNS name that resolves to a private address. The Python kernel checks the address it actually
 * connects to.
 */

/** Programs whose operands are hosts or URLs. */
const NET_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "rsync", "ftp", "socat", "aria2c", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"]);

const METADATA_NAMES = new Set(["metadata.google.internal", "metadata.goog", "metadata", "instance-data", "instance-data.ec2.internal", "metadata.azure.com"]);

/** An IPv4 address in any form `inet_aton` accepts (`169.254.169.254`, `2852039166`, `0xa9.0376.43518`), as four bytes. */
export function ipv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return undefined;
  const nums: number[] = [];
  for (const p of parts) {
    const n = /^0x[0-9a-f]+$/i.test(p) ? parseInt(p, 16) : /^0[0-7]*$/.test(p) ? parseInt(p, 8) : /^[1-9][0-9]*$/.test(p) ? parseInt(p, 10) : NaN;
    if (!Number.isFinite(n)) return undefined;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return undefined;
  const tail: number[] = [];
  for (let i = 0, v = last; i < 4 - nums.length; i++, v = Math.floor(v / 256)) tail.unshift(v % 256);
  return [...nums, ...tail];
}

/** The IPv4 address inside an IPv6 one that carries it (`::ffff:a.b.c.d`, `::a.b.c.d`, `::ffff:a9fe:a9fe`). */
function mappedV4(v6: string): number[] | undefined {
  const dotted = /^(?:0*:)*(?:ffff:)?((?:\d+\.){3}\d+)$/i.exec(v6.replace(/^::/, "0:"));
  if (dotted) return ipv4(dotted[1]!);
  const hex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6.replace(/^::/, "0:"));
  if (hex) {
    const a = parseInt(hex[1]!, 16);
    const b = parseInt(hex[2]!, 16);
    return [a >> 8, a & 255, b >> 8, b & 255];
  }
  return undefined;
}

/** A host as rules see it: lower case, no brackets, no trailing dot, an IPv4 address in dotted form. */
export function normalHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const v4 = ipv4(h) ?? (h.includes(":") ? mappedV4(h) : undefined);
  if (v4) h = v4.join(".");
  return h;
}

/** A cloud metadata service, or any link-local address (where they all live). */
export function isMetadata(host: string): boolean {
  const h = normalHost(host);
  if (METADATA_NAMES.has(h)) return true;
  const v4 = ipv4(h);
  if (v4) return (v4[0] === 169 && v4[1] === 254) || v4.join(".") === "100.100.100.200";
  return /^fe[89ab][0-9a-f]:/i.test(h) || h === "fd00:ec2::254";
}

/** The host of a URL or `user@host:path`, or of a bare `host[:port][/path]` operand. */
function hostOf(word: string, bare: boolean): string | undefined {
  const w = word.replace(/^['"]|['"]$/g, "");
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)/i.exec(w);
  if (url) return url[1];
  const remote = /^[^@\s/:]+@(\[[^\]]+\]|[^:/\s]+):/.exec(w);
  if (remote) return remote[1];
  if (!bare || w.startsWith("-") || w.startsWith("/") || w.startsWith(".")) return undefined;
  const plain = /^(?:[^@\s/]+@)?(\[[^\]]+\]|[A-Za-z0-9.-]+)(?::\d+)?(?:\/.*)?$/.exec(w);
  return plain && (plain[1]!.includes(".") || plain[1]!.startsWith("[") || ipv4(plain[1]!)) ? plain[1] : undefined;
}

/** Every host a command line names, as `normalHost` writes it. */
export function hostsIn(command: string): string[] {
  const out = new Set<string>();
  const words = command.split(/[\s;&|()<>`]+/).filter(Boolean);
  let net = false;
  for (const word of words) {
    const name = word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
    if (NET_PROGRAMS.has(name)) {
      net = true;
      continue;
    }
    const host = hostOf(word, net);
    if (host) out.add(normalHost(host));
  }
  // An address written anywhere (`python -c "...169.254.169.254..."`) and the metadata names.
  for (const m of command.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) if (ipv4(m[0])) out.add(normalHost(m[0]));
  for (const name of METADATA_NAMES) if (name.includes(".") && command.toLowerCase().includes(name)) out.add(name);
  return [...out];
}
