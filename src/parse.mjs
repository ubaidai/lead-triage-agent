/**
 * CSV parsing and field normalisation.
 *
 * Hand-rolled rather than a library because the fixture is the input under
 * test: a dependency that silently repairs a malformed row would hide exactly
 * the thing this challenge is checking for. Everything that looks wrong is kept
 * and reported, never coerced into looking right.
 */

/** RFC4180-ish reader. Handles quoted fields, embedded commas and "" escapes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;

  // Strip a BOM. It would otherwise become part of the first header name and
  // every lookup of that column would miss.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift();
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r, n) => {
      const o = { _line: n + 2 };
      header.forEach((h, k) => { o[h] = r[k] ?? ''; });
      return o;
    });
}

/**
 * Budget arrives as a number, as "15k", as "we'll discuss", or as nothing.
 *
 * Returns null for anything that is not a number, and the caller treats null as
 * "not established" rather than as zero. A lead with an unparseable budget is
 * not a lead with no budget, and collapsing the two is how a real prospect gets
 * auto-rejected.
 */
export function parseBudget(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, reason: 'empty' };

  const cleaned = s.replace(/[$,\s]/g, '').toLowerCase();
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(cleaned);
  if (!m) return { value: null, reason: 'unparseable', raw: s };

  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1_000;
  if (m[2] === 'm') n *= 1_000_000;
  if (!Number.isFinite(n)) return { value: null, reason: 'unparseable', raw: s };
  return { value: n, reason: m[2] ? `normalised from "${s}"` : 'ok' };
}

/**
 * Strict ISO-8601 check. Date.parse accepts things it should not and rolls
 * overflow silently, so month 13 would become January of the next year and the
 * malformed timestamp would vanish instead of being reported.
 */
export function parseTimestamp(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { value: null, reason: 'empty' };

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(s);
  if (!m) return { value: null, reason: 'not ISO-8601', raw: s };

  const [, y, mo, d, h, mi, sec] = m.map(Number);
  const inRange = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 &&
                  h <= 23 && mi <= 59 && sec <= 59;
  if (!inRange) return { value: null, reason: 'impossible date or time', raw: s };

  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  // Catches day 31 of a 30-day month, which passes the range check above.
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { value: null, reason: 'day does not exist in month', raw: s };
  }
  return { value: dt.toISOString(), reason: 'ok' };
}

/** Decode the handful of HTML entities that appear in form submissions. */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

/**
 * Strip markup from a message for display and length checks.
 *
 * The original is always kept alongside. Tags in a form submission are a signal
 * worth recording, not noise to quietly delete.
 */
export function normaliseMessage(raw) {
  const original = String(raw ?? '');
  const hadMarkup = /<[a-z][^>]*>/i.test(original) || /&(amp|lt|gt|quot|#39|nbsp);/.test(original);
  const text = decodeEntities(original.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return { original, text, hadMarkup };
}

export function normaliseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '') return { value: null, domain: null, valid: false, reason: 'empty' };
  const m = /^[^\s@]+@([^\s@.]+(?:\.[^\s@.]+)+)$/.exec(s);
  if (!m) return { value: s, domain: null, valid: false, reason: 'malformed' };
  return { value: s, domain: m[1], valid: true, reason: 'ok' };
}
