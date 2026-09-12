/**
 * The loop. Reads the fixture, decides every row, writes the decisions file and
 * a run log.
 *
 * Every row in the fixture is processed. Nothing is skipped, and a row that
 * fails produces an ESCALATE with the failure as its reason rather than being
 * dropped, because a lead that vanished is indistinguishable from a lead that
 * never arrived.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCsv } from './parse.mjs';
import { validateLead } from './validate.mjs';
import { decideStructural, applyGuardrails } from './decide.mjs';
import { judge } from './llm.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'fixtures', 'inbound_leads.csv');
const OUT = join(ROOT, 'out');

/** Read KEY=value from a .env file without pulling in a dependency. */
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const csvCell = (s) => {
  const v = String(s ?? '');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

async function main() {
  loadEnv(join(ROOT, '.env'));
  const apiKey = process.env.OPENROUTER_API_KEY;
  const offline = process.argv.includes('--offline');

  const raw = readFileSync(FIXTURE);
  const checksum = createHash('sha256').update(raw).digest('hex');
  const rows = parseCsv(raw.toString('utf8'));

  console.log(`fixture   ${FIXTURE}`);
  console.log(`sha256    ${checksum}`);
  console.log(`rows      ${rows.length}`);
  console.log(`model     ${offline ? 'none (--offline)' : process.env.LLM_MODEL ?? 'anthropic/claude-haiku-4.5'}`);
  console.log('');

  const seenEmail = new Map();
  const decisions = [];
  const log = [];

  for (const row of rows) {
    const v = validateLead(row, seenEmail);
    const entry = {
      lead_id: row.lead_id,
      line: row._line,
      flags: v.flags,
      path: null,
      llm: null,
      guardrails: [],
    };

    let out = decideStructural(v);
    if (out) {
      entry.path = 'structural';
    } else if (offline) {
      entry.path = 'offline';
      out = {
        decision: 'ESCALATE',
        reason: 'Structural checks passed but the judgment layer was not run in offline mode.',
        confidence: 0.3,
        route: 'human_review',
      };
    } else {
      entry.path = 'model';
      let j;
      try {
        j = await judge(v, row, { apiKey });
      } catch (err) {
        j = { ok: false, error: err.message };
      }

      if (!j.ok) {
        // A failed or malformed judgment is not a reason to guess.
        entry.llm = { ok: false, error: j.error, raw: j.raw ?? null, ms: j.ms ?? null };
        out = {
          decision: 'ESCALATE',
          reason: `Judgment layer failed (${j.error}); row needs a person.`,
          confidence: 0.2,
          route: 'human_review',
        };
      } else {
        entry.llm = {
          ok: true, model: j.model, ms: j.ms, usage: j.usage,
          decision: j.decision, reason: j.reason, confidence: j.confidence,
          prompt: j.prompt,
        };
        const g = applyGuardrails(j, v);
        entry.guardrails = g.notes;
        out = { ...g, route: g.decision === 'ESCALATE' ? 'human_review' : 'none' };
      }
    }

    entry.final = { decision: out.decision, reason: out.reason, confidence: out.confidence, route: out.route };
    log.push(entry);
    decisions.push({
      lead_id: row.lead_id,
      decision: out.decision,
      reason: out.reason,
      confidence: out.confidence,
    });

    const codes = v.flags.map((f) => f.code).join(',') || '-';
    console.log(`${row.lead_id}  ${out.decision.padEnd(8)} ${String(out.confidence).padEnd(5)} [${entry.path}] ${codes}`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'decisions.csv'),
    'lead_id,decision,reason,confidence\n' +
    decisions.map((d) => [d.lead_id, d.decision, d.reason, d.confidence].map(csvCell).join(',')).join('\n') + '\n');
  writeFileSync(join(OUT, 'decisions.json'), JSON.stringify(decisions, null, 2) + '\n');
  writeFileSync(join(OUT, 'run-log.jsonl'),
    log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(join(OUT, 'run-meta.json'), JSON.stringify({
    fixture_sha256: checksum,
    brief_version: '2026-07',
    rows: rows.length,
    model: offline ? null : (process.env.LLM_MODEL ?? 'anthropic/claude-haiku-4.5'),
    ran_at: new Date().toISOString(),
    counts: decisions.reduce((a, d) => ({ ...a, [d.decision]: (a[d.decision] ?? 0) + 1 }), {}),
  }, null, 2) + '\n');

  const counts = decisions.reduce((a, d) => ({ ...a, [d.decision]: (a[d.decision] ?? 0) + 1 }), {});
  console.log('\n' + Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('   '));
  console.log(`wrote ${decisions.length} decisions to out/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
