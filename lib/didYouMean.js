/**
 * Candidate scoring for "did you mean" suggestions — the shared machinery #11
 * asks for.
 *
 * Parameter names are the smallest, best-defined candidate set on this surface
 * (a tool declares two to six of them), so the scoring is proven here before
 * #6 points the same primitive at the far larger canonical-field set. #6 layers
 * O-DEF-code lookup and a confidence score on top; the normalisation +
 * edit-distance + prefix ranking below is the part it should reuse rather than
 * reimplement. The module is deliberately framework-free (no Zod, no SDK
 * import) and lives under lib/ — which the npm package publishes — so the
 * backend validator can adopt the same code instead of growing a parallel
 * scorer.
 *
 * Status: NOT yet wired into the live rejection message. The MCP SDK renders a
 * strict schema's rejection itself ("Unrecognized key(s) in object: 'query'")
 * via createToolError(error.message), with no error-formatting hook, and a
 * custom Zod refinement able to carry a suggestion would stop the schema from
 * publishing additionalProperties:false. Surfacing the suggestion therefore
 * needs a small error-rendering seam, tracked separately. The correctness half
 * of #11 (P1-P4) does not depend on it: the SDK message already names the key.
 */

/** Lower-case and drop separators, so sector_id, sectorId and SECTOR-ID compare equal. */
export function normalizeName(name) {
  return String(name).replace(/[_\-\s]+/g, '').toLowerCase();
}

/** Classic Levenshtein distance between two strings. */
export function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const row = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[t.length];
}

/**
 * Rank `candidates` by how likely each is the intended target of `unknown`.
 *
 * A candidate qualifies if, after normalisation, it is a prefix of the unknown
 * name (query -> q, sectorId -> sector) or within `maxDistance` edits of it (a
 * typo). Prefix hits outrank edit-distance hits; nearer outranks farther; ties
 * break alphabetically for a stable order. Returns at most `limit` candidate
 * strings, best first — and, importantly, an empty array when nothing is close,
 * because a suggestion for a genuinely foreign key is worse than silence.
 */
export function suggestNames(unknown, candidates, { maxDistance = 2, limit = 3 } = {}) {
  const u = normalizeName(unknown);
  const scored = [];
  for (const candidate of candidates) {
    const n = normalizeName(candidate);
    if (n === u) continue; // an exact post-normalisation match is not a suggestion
    const distance = editDistance(u, n);
    const prefix = n.startsWith(u) || u.startsWith(n);
    if (!prefix && distance > maxDistance) continue;
    scored.push({ candidate, distance, prefix });
  }
  scored.sort(
    (x, y) => Number(y.prefix) - Number(x.prefix) || x.distance - y.distance || x.candidate.localeCompare(y.candidate)
  );
  return scored.slice(0, limit).map((s) => s.candidate);
}

/** 'Did you mean "q"?' — or '' when nothing is close enough to suggest. */
export function didYouMean(unknown, candidates, opts) {
  const suggestions = suggestNames(unknown, candidates, opts);
  if (!suggestions.length) return '';
  return `Did you mean ${suggestions.map((s) => `"${s}"`).join(' or ')}?`;
}
