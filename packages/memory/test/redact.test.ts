import { test, expect } from "bun:test";
import { redact } from "../src/index.ts";

test("credential shapes are redacted, ordinary text is not", () => {
  const keys = [
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "sk-proj-abcdefghijklmnopqrstuv",
    "oc_sk_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF",
    "sk_live_" + "abcdefghijklmnop1234",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "github_pat_11ABCDEFG0123456789_abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----",
  ];
  for (const k of keys) expect(redact(`key: ${k} end`)).toBe("key: [redacted] end");
  for (const ok of ["task_sk_list", "use pnpm, not npm", "risk_assessment_doc", "desk_setup"]) expect(redact(ok)).toBe(ok);
});

test("the shapes people paste: headers, URLs with passwords, assignments, vendor tokens, tokens with zero-width characters", () => {
  const leaks = [
    'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345" https://api',
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    "psql postgres://app:hunter2hunter2@db.internal/shop",
    'password="correct horse battery staple"',
    "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "//registry.npmjs.org/:_authToken=npmabcdefghijklmnop12345678",
    "glpat-abcdefghijklmnopqrstu",
    "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuv",
    "mysql --password hunter2hunter2",
    "sk-ant-api​03-abcdefghijklmnopqrstuv",
  ];
  for (const l of leaks) expect([l, redact(l).includes("[redacted]")]).toEqual([l, true]);
  expect(redact("the author wrote this; tokens are refreshed hourly")).toBe("the author wrote this; tokens are refreshed hourly");
});

test("a private key that is cut off is redacted, and a pile of BEGIN markers does not take quadratic time", () => {
  expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn")).toBe("[redacted]");
  const t0 = Date.now();
  redact("-----BEGIN PRIVATE KEY-----".repeat(8000));
  expect(Date.now() - t0).toBeLessThan(1000);
});
