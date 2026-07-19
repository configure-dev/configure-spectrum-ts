#!/usr/bin/env node
// Usage: node evals/run.mjs [--label baseline] [--only shouldFire|shouldNotFire] [--max N] [--cwd DIR]
// Runs each scenario headless in --cwd (must be a project with the configure
// MCP configured) and counts mcp__configure__ tool calls from stream-json.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(HERE, "scenarios.json"), "utf8"));
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const label = arg("label", "run");
const only = arg("only", null);
const max = Number(arg("max", "99"));
const cwd = arg("cwd", process.cwd());

function runOne(s) {
  let out = "";
  try {
    out = execFileSync(
      "claude",
      [
        "-p", s.prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", "6",
        "--allowedTools", "mcp__configure,mcp__configure__*,Read,Bash,Write,Edit,Glob,Grep",
      ],
      { encoding: "utf8", timeout: 300000, cwd, maxBuffer: 64 * 1024 * 1024 }
    );
  } catch (e) {
    out = String(e.stdout || "");
  }
  const calls = [];
  let finalText = "";
  for (const line of out.split("\n")) {
    try {
      const j = JSON.parse(line);
      if (j.type === "result") finalText = j.result ?? "";
      const blocks = j.message?.content ?? [];
      for (const b of blocks)
        if (b.type === "tool_use" && b.name?.startsWith("mcp__configure__")) calls.push(b.name.replace("mcp__configure__", ""));
    } catch {}
  }
  return { calls, finalText: String(finalText).slice(0, 500) };
}

const results = [];
for (const group of ["shouldFire", "shouldNotFire"]) {
  if (only && only !== group) continue;
  for (const s of scenarios[group].slice(0, max)) {
    const { calls, finalText } = runOne(s);
    const fired = calls.length > 0;
    // A should-fire scenario also passes when the reply is visibly
    // profile-informed without a call — with digest injection, context can be
    // pre-loaded and the tool call is legitimately unnecessary.
    const informed = s.outcome ? new RegExp(s.outcome, "i").test(finalText) : false;
    const pass = group === "shouldFire" ? fired || informed : !fired;
    results.push({ group, id: s.id, fired, informed, pass, calls, finalText });
    console.log(`${pass ? "PASS" : "FAIL"}  [${group}] ${s.id}  calls=${calls.join(",") || "none"}${!fired && informed ? "  (profile-informed)" : ""}`);
  }
}
const fire = results.filter((r) => r.group === "shouldFire");
const noFire = results.filter((r) => r.group === "shouldNotFire");
const pct = (arr) => (arr.length ? Math.round((100 * arr.filter((r) => r.pass).length) / arr.length) : NaN);
const summary = {
  label,
  shouldFirePassPct: pct(fire),
  shouldNotFirePassPct: pct(noFire),
  results,
};
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", `${label}.json`), JSON.stringify(summary, null, 2));
console.log(`\nshould-fire: ${pct(fire)}%  should-not-fire clean: ${pct(noFire)}%  -> evals/results/${label}.json`);
