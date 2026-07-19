import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "configure-memory");

function bundleFrom(skillDir: string): string {
  const out = join(mkdtempSync(join(tmpdir(), "cm-bundle-")), "install.mjs");
  execFileSync("node", [join(skillDir, "scripts", "bundle.mjs"), out], { encoding: "utf8" });
  return out;
}

describe("bundle.mjs", () => {
  it("generates a syntactically valid polyglot installer (parses as ESM and as CJS)", () => {
    const out = bundleFrom(SKILL);
    execFileSync("node", ["--check", out]); // .mjs path => ESM parse
    const asCjs = out.replace(/install\.mjs$/, "install.cjs");
    writeFileSync(asCjs, readFileSync(out));
    execFileSync("node", ["--check", asCjs]); // CJS parse (the `| node -` stdin case)
    const src = readFileSync(out, "utf8");
    expect(src).toContain("mkdtempSync");
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/^import /m);
  });

  it("is injection-proof: hostile skill content installs as inert literal data", () => {
    const staged = mkdtempSync(join(tmpdir(), "cm-skill-"));
    cpSync(SKILL, staged, { recursive: true, filter: (s) => !s.includes("node_modules") });
    const payload = 'canary-`${process.env.PWNED}`-</script>-"quotes"-\\backslash';
    appendFileSync(join(staged, "SKILL.md"), "\n" + payload);
    const out = bundleFrom(staged);
    execFileSync("node", ["--check", out]);
    const fakeHome = mkdtempSync(join(tmpdir(), "cm-home-"));
    execFileSync("node", [out], { env: { ...process.env, HOME: fakeHome, PWNED: "INJECTED" }, encoding: "utf8" });
    const installed = readFileSync(join(fakeHome, ".claude", "skills", "configure-memory", "SKILL.md"), "utf8");
    expect(installed).toContain(payload); // literal, byte-for-byte
    expect(installed).not.toContain("INJECTED"); // never interpolated
  });
});
