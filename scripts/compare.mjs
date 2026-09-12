/**
 * Agent output against a manual pass over the same 20 rows.
 *
 * The manual pass was written before the model run was read back, so this is a
 * comparison rather than a grading of the agent against itself. It exists to
 * find the rows where an automated call and a human call diverge, because those
 * are the rows that decide whether this is safe to leave running.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const agent = new Map(
  JSON.parse(readFileSync(join(ROOT, 'out', 'decisions.json'), 'utf8'))
    .map((d) => [d.lead_id, d]));
const manual = new Map(
  parseCsv(readFileSync(join(ROOT, 'evidence', 'manual_pass.csv'), 'utf8'))
    .map((r) => [r.lead_id, r]));

const ids = [...manual.keys()];
const rows = ids.map((id) => ({
  id,
  manual: manual.get(id).manual_decision,
  agentDecision: agent.get(id)?.decision ?? 'MISSING',
  agentReason: agent.get(id)?.reason ?? '',
  manualReason: manual.get(id).manual_reason,
}));

const agreed = rows.filter((r) => r.manual === r.agentDecision);
const disagreed = rows.filter((r) => r.manual !== r.agentDecision);

console.log(`rows compared      ${rows.length}`);
console.log(`agreed             ${agreed.length}`);
console.log(`disagreed          ${disagreed.length}`);
console.log(`agreement rate     ${((agreed.length / rows.length) * 100).toFixed(0)}%`);

// Direction matters more than the rate. An agent that escalates what a human
// would reject costs review time. An agent that decides what a human would
// escalate costs a customer.
const towardHuman = disagreed.filter((r) => r.agentDecision === 'ESCALATE');
const awayFromHuman = disagreed.filter((r) => r.manual === 'ESCALATE' && r.agentDecision !== 'ESCALATE');
console.log(`\nagent escalated where the manual pass decided   ${towardHuman.length}  (costs review time)`);
console.log(`agent decided where the manual pass escalated   ${awayFromHuman.length}  (costs a customer)`);

if (disagreed.length) {
  console.log('\n--- disagreements ---');
  for (const r of disagreed) {
    console.log(`\n${r.id}   manual ${r.manual}  ->  agent ${r.agentDecision}`);
    console.log(`  manual: ${r.manualReason}`);
    console.log(`  agent:  ${r.agentReason}`);
  }
}

const dist = (get) => rows.reduce((a, r) => ({ ...a, [get(r)]: (a[get(r)] ?? 0) + 1 }), {});
console.log('\nmanual distribution', JSON.stringify(dist((r) => r.manual)));
console.log('agent  distribution', JSON.stringify(dist((r) => r.agentDecision)));
