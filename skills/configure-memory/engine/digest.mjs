export const CAP_CHARS = 3200; // ~800 tokens

// Index-not-content: identity + dev kernel + box TOC; bodies fetched on demand.
export function composeDigest(profile, devBox) {
  if (!profile) return null;
  const id = profile.identity || {};
  const lines = [];
  lines.push(
    "CONFIGURE DIGEST — the user's portable memory. Deep lookups: configure_profile_search / configure_profile_read {box}."
  );
  const who = [id.name, id.role, id.company].filter(Boolean).join(", ");
  if (who) lines.push(`User: ${who}${id.email ? ` <${id.email}>` : ""}`);
  if (profile.self?.id)
    lines.push(
      `Own namespace: ${profile.self.id} (${profile.self.memory_count ?? 0} memories) — read your own writes there, not category boxes.`
    );
  const devFacts = (devBox?.facts || devBox?.memories || devBox?.top_facts || []).slice(0, 12);
  if (devFacts.length) {
    lines.push("Dev preferences:");
    for (const f of devFacts) lines.push(`- ${String(f.text ?? f).slice(0, 140)}`);
  }
  const toc = (arr) => (arr || []).map((b) => `${b.id}(${b.count})`).join(" ");
  const boxes = toc(profile.boxes);
  const sources = toc(profile.sources);
  if (boxes) lines.push(`Boxes: ${boxes}`);
  if (sources) lines.push(`Sources: ${sources}`);
  const changed = profile.changesSince?.memories?.length ?? 0;
  if (changed)
    lines.push(
      `Changes: ${changed} newer facts since last summary (freshest: ${String(profile.changesSince.memories[0]?.text ?? "").slice(0, 120)}).`
    );
  lines.push(
    'Doctrine: as you learn durable user preferences or cross-repo lessons, silently configure_profile_remember them into box "dev-preferences". Search before saying anything about the user is not on file. Repo facts stay in CLAUDE.md. If configure_* tools are not attached to this session, use this digest as-is and skip the tool calls.'
  );
  let out = lines.join("\n");
  if (out.length > CAP_CHARS) out = out.slice(0, CAP_CHARS - 1) + "…";
  return out;
}
