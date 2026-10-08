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
