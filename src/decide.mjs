/**
 * Policy. Turns flags plus an optional model judgment into one decision.
 *
 * Two rules shape everything here.
 *
 * Structure beats judgment. If a deterministic check already settles the row,
 * the model is not called at all. That saves a request, and more importantly it
 * means the answer for a malicious link does not depend on a sampling outcome.
 *
 * Escalation is the default failure mode. Every path that cannot be resolved
 * confidently ends at ESCALATE with a reason, never at a guess. A wrong REJECT
 * is a lost customer nobody ever hears about, which is the expensive kind of
 * wrong.
 */

import { hasFlag, blocking } from './validate.mjs';

const D = (decision, reason, confidence, route) => ({ decision, reason, confidence, route });

/**
 * The row contradicts itself, so nothing it says can be taken at face value.
 * These escalate whatever the model concluded.
 *
 * This list started as a QUALIFY-only guard, which missed L-007: a 12,000
 * employee CPG running a global rebrand, budget field reading 50. The model
 * spotted the contradiction, wrote "requires clarification" in its reason, and
 * filed it NURTURE. Correct diagnosis, wrong action, and a drip campaign is
 * where that lead would have died. Over-calling QUALIFY is not the only way to
 * be wrong; under-calling an enterprise lead is quieter and costs more.
 */
const CONTRADICTION = [
  'CONFLICTING_SIGNALS',
  'UNVERIFIABLE_CLAIM',
  'WITHHELD_IDENTITY',
];

/**
 * Information is missing rather than contradictory. Not enough to act on, but
 * not a reason to pull a sensible NURTURE or REJECT back to a human.
 */
const QUALIFY_BLOCKERS = [
  'LIKELY_COMPETITOR',
  'BUDGET_UNPARSEABLE',
  'UPFRONT_DEMAND',
];

/**
 * Decide without the model. Returns null when the row needs judgment.
 *
 * Order is deliberate: safety and legal first, because those must win even when
 * the row also looks like a decent lead.
 */
export function decideStructural(v) {
  const f = v.flags;

  if (hasFlag(f, 'SECURITY_RISK')) {
    // Not REJECT. Rejecting files a phishing attempt as a dead lead and nobody
    // finds out. One human sees this once, then it is a security ticket.
    return D('ESCALATE', 'Message contains a link to an executable under a billing pretext; routed to security, not sales.', 0.97, 'security');
  }

  if (hasFlag(f, 'LEGAL_REQUEST')) {
    return D('ESCALATE', 'Data-rights request rather than a sales enquiry; must be handled by whoever owns privacy requests within the statutory window.', 0.97, 'privacy');
  }

  if (hasFlag(f, 'PROMPT_INJECTION')) {
    return D('ESCALATE', 'Message contains text written to manipulate the classifier, so the stated budget and authority cannot be taken at face value.', 0.93, 'human_review');
  }

  if (hasFlag(f, 'LIKELY_TEST_ROW')) {
    return D('REJECT', 'Placeholder values across name, company and message; this is a form test, not a lead.', 0.95, 'none');
  }

  const blocked = blocking(f);
  if (blocked.length) {
    return D('ESCALATE', `Cannot act on this row: ${blocked.map((b) => b.detail).join('; ')}.`, 0.9, 'human_review');
  }

  return null;
}

/**
 * Apply guardrails to a model judgment.
 *
 * The model only ever sees rows that already passed structural validation, so
 * this is about disagreement between what it concluded and what the row shows.
 */
export function applyGuardrails(judgment, v) {
  const f = v.flags;
  let { decision, reason, confidence } = judgment;
  const notes = [];

  const contradicted = CONTRADICTION.filter((c) => hasFlag(f, c));
  if (decision !== 'ESCALATE' && contradicted.length) {
    notes.push(`escalated from ${decision} on ${contradicted.join(', ')}`);
    const detail = f.filter((x) => contradicted.includes(x.code)).map((x) => x.detail).join('; ');
    decision = 'ESCALATE';
    reason = `The row contradicts itself and a person has to resolve it before this is routed: ${detail}.`;
    confidence = Math.min(confidence, 0.6);
  }

  const tripped = QUALIFY_BLOCKERS.filter((c) => hasFlag(f, c));
  if (decision === 'QUALIFY' && tripped.length) {
    notes.push(`downgraded from QUALIFY on ${tripped.join(', ')}`);
    const detail = f.filter((x) => tripped.includes(x.code)).map((x) => x.detail).join('; ');
    decision = 'ESCALATE';
    reason = `Looks commercially plausible but the row contradicts itself: ${detail}.`;
    confidence = Math.min(confidence, 0.6);
  }

  if (hasFlag(f, 'DUPLICATE_EMAIL')) {
    const dup = f.find((x) => x.code === 'DUPLICATE_EMAIL');
    notes.push('duplicate address');
    // Not dropped. The second message from an address is sometimes the real
    // lead, so a person merges rather than the pipeline deleting.
    decision = 'ESCALATE';
    reason = `${dup.detail}; merge with the earlier submission before routing, the two messages describe different asks.`;
    confidence = Math.min(confidence, 0.7);
  }

  if (decision !== 'ESCALATE' && confidence < 0.5) {
    notes.push(`model confidence ${confidence} below threshold`);
    decision = 'ESCALATE';
    reason = `Model was not confident enough to act: ${reason}`;
  }

  return { decision, reason, confidence: Number(confidence.toFixed(2)), notes };
}
