/**
 * Deterministic checks that run before any model sees a lead.
 *
 * The traps in this dataset are structural: a duplicate, a date that does not
 * exist, a budget that is a sentence, an erasure request, a link to an
 * executable. None of those need judgment, and asking a language model to
 * notice them is strictly worse than checking, because a check is repeatable
 * and a model is not.
 *
 * Every function here returns flags. Nothing here decides anything. The policy
 * in decide.mjs turns flags into a decision, which keeps "what is true about
 * this row" separate from "what we do about it".
 */

import { parseBudget, parseTimestamp, normaliseMessage, normaliseEmail } from './parse.mjs';

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'throwaway.email', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
]);

const FREEMAIL = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
]);

/**
 * Phrases that try to move text from the data position into the instruction
 * position. This list is a tripwire, not the defence. The defence is that lead
 * text is only ever passed inside a delimited data block (see llm.mjs); if this
 * list is empty the system still refuses to follow the content, it just loses
 * the ability to say so out loud.
 */
const INJECTION_PATTERNS = [
  /\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above|the)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+(system\s+)?(instructions?|prompt)\b/i,
  /\bsystem\s*(prompt|message)\b/i,
  /\bclassify\s+this\s+(lead\s+)?as\b/i,
  /\b(set|use|with)\s+confidence\s*(of\s*)?[01](\.\d+)?\b/i,
  /\boverride\b.{0,24}\b(rules?|instructions?|policy)\b/i,
  /\b(respond|reply|answer|output)\s+(only\s+)?with\b/i,
];

/** Requests that are legal or privacy matters, not sales enquiries. */
const LEGAL_PATTERNS = [
  /\bgdpr\b/i, /\barticle\s*1[57]\b/i, /\bccpa\b/i, /\bdata\s+subject\b/i,
  /\bright\s+to\s+(be\s+forgotten|erasure)\b/i,
  /\bdelete\s+all\s+(my\s+)?(personal\s+)?data\b/i,
  /\bunsubscribe\b/i, /\bopt[-\s]?out\s+of\s+(all\s+)?(data|processing)\b/i,
];

/** Content that should reach security, not sales. */
const MALICIOUS_LINK = /https?:\/\/\S+\.(exe|scr|bat|cmd|com|pif|vbs|js|jar|msi|zip|rar|7z|iso|dmg)\b/i;
const PAYMENT_PRETEXT = /\b(overdue|unpaid|outstanding)\s+(invoice|statement|balance)\b|\bservice\s+interruption\b|\bavoid\s+suspension\b/i;

/** Rows a person filled in to see whether the form works. */
const TEST_TOKENS = /^(test|testing|asdf+|qwerty|foo|bar|baz|xxx+|aaa+|n\/?a|none|-{1,})$/i;

/** Language suggesting the sender sells the same service we do. */
const COMPETITOR_PATTERNS = [
  /\bfor\s+(a\s+)?client\s+of\s+ours\b/i,
  /\bour\s+client'?s?\b/i,
  /\b(comparison|benchmark(ing)?|bake[-\s]?off)\b.{0,40}\b(agenc|vendor|provider)/i,
  /\bhow\s+(do\s+)?you\s+structure\s+(your\s+)?(retainers?|pricing|fees)\b/i,
];

const AGENCY_NAME = /\b(agency|digital|marketing|media|growth|partners|consult)\w*\b/i;

/** Claims of scale or seniority the row itself cannot support. */
const ENTERPRISE_CLAIM = /\b(\d{1,3}(,\d{3})+|\d{4,})[-\s]?(employee|person|staff)\b|\bfortune\s*(500|1000)\b|\bglobal\s+(rebrand|rollout|program)\b|\benterprise[-\s]wide\b/i;
const SENIORITY_CLAIM = /\b(vp|vice\s+president|chief|c[etfo]o|head)\s+of\b|\b(vp|svp|evp)\b/i;
const WITHHOLDING = /\bcan'?t\s+(share|say|disclose|name)\b|\bunder\s+nda\b|\bnot\s+at\s+liberty\b/i;
const URGENCY = /\bready\s+to\s+sign\b|\bthis\s+week\b|\basap\b|\bimmediately\b|\bright\s+away\b/i;

/** Asking for deliverables up front, before any conversation. */
const UPFRONT_DEMAND = /\bsend\s+(over\s+)?(your\s+)?(complete|full|entire)?\s*(methodology|deck|proposal|playbook|past\s+client\s+results?|case\s+studies)\b/i;

const flag = (code, detail, severity) => ({ code, detail, severity });

/**
 * @param {object} row      one parsed CSV row
 * @param {Map}    seenEmail email -> first lead_id that used it
 */
export function validateLead(row, seenEmail) {
  const flags = [];

  const email = normaliseEmail(row.email);
  const budget = parseBudget(row.monthly_budget_usd);
  const ts = parseTimestamp(row.submitted_at);
  const msg = normaliseMessage(row.message);
  const company = String(row.company ?? '').trim();
  const website = String(row.website ?? '').trim();
  const name = String(row.name ?? '').trim();

  // ── contactability ───────────────────────────────────────────────────────
  if (!email.value) flags.push(flag('MISSING_EMAIL', 'no email address on the row', 'block'));
  else if (!email.valid) flags.push(flag('MALFORMED_EMAIL', `"${email.value}" is not a valid address`, 'block'));

  if (email.domain && DISPOSABLE.has(email.domain)) {
    flags.push(flag('DISPOSABLE_EMAIL', `${email.domain} is a throwaway domain`, 'block'));
  }

  if (!company) flags.push(flag('MISSING_COMPANY', 'company field is empty', 'warn'));
  if (!website) flags.push(flag('MISSING_WEBSITE', 'website field is empty', 'warn'));

  // ── field integrity ──────────────────────────────────────────────────────
  if (ts.value === null && ts.reason !== 'empty') {
    flags.push(flag('MALFORMED_TIMESTAMP', `${ts.reason}: "${ts.raw}"`, 'warn'));
  }
  if (budget.value === null && budget.reason === 'unparseable') {
    flags.push(flag('BUDGET_UNPARSEABLE', `"${budget.raw}" is not a number`, 'warn'));
  }
  if (budget.value !== null && budget.value >= 500_000) {
    flags.push(flag('BUDGET_IMPLAUSIBLE', `${budget.value} is outside any real retainer range`, 'warn'));
  }
  if (msg.text === '') flags.push(flag('EMPTY_MESSAGE', 'no message body', 'warn'));
  if (msg.hadMarkup) flags.push(flag('MARKUP_IN_MESSAGE', 'message contained HTML or entities, stripped for analysis', 'info'));

  // ── junk ─────────────────────────────────────────────────────────────────
  const junkName = TEST_TOKENS.test(name);
  const junkCompany = company !== '' && TEST_TOKENS.test(company);
  const junkMessage = msg.text !== '' && (TEST_TOKENS.test(msg.text) || /^(.)\1{5,}$/.test(msg.text.replace(/\s/g, '')));
  if ([junkName, junkCompany, junkMessage].filter(Boolean).length >= 2) {
    flags.push(flag('LIKELY_TEST_ROW', 'placeholder values in two or more fields', 'block'));
  }

  // ── adversarial and out-of-scope ─────────────────────────────────────────
  const hit = INJECTION_PATTERNS.find((p) => p.test(msg.text));
  if (hit) flags.push(flag('PROMPT_INJECTION', 'message contains text addressed to the classifier', 'block'));

  if (LEGAL_PATTERNS.some((p) => p.test(msg.text))) {
    flags.push(flag('LEGAL_REQUEST', 'privacy or data-rights request, not a sales enquiry', 'block'));
  }
  if (MALICIOUS_LINK.test(msg.original) || (PAYMENT_PRETEXT.test(msg.text) && /https?:\/\//.test(msg.original))) {
    flags.push(flag('SECURITY_RISK', 'executable link or payment pretext in the message body', 'block'));
  }

  // ── commercial signals ───────────────────────────────────────────────────
  if (COMPETITOR_PATTERNS.some((p) => p.test(msg.text)) && AGENCY_NAME.test(company)) {
    flags.push(flag('LIKELY_COMPETITOR', 'agency-sounding company asking about our pricing structure', 'warn'));
  }
  if (UPFRONT_DEMAND.test(msg.text)) {
    flags.push(flag('UPFRONT_DEMAND', 'asking for full methodology or client results before any conversation', 'warn'));
  }

  const claimsScale = ENTERPRISE_CLAIM.test(msg.text);
  if (claimsScale && budget.value !== null && budget.value < 1_000) {
    flags.push(flag('CONFLICTING_SIGNALS',
      `message describes enterprise scope but budget reads ${budget.value}`, 'warn'));
  }
  if (SENIORITY_CLAIM.test(msg.text) && email.domain && FREEMAIL.has(email.domain)) {
    flags.push(flag('UNVERIFIABLE_CLAIM',
      `seniority claim from a ${email.domain} address`, 'warn'));
  }
  if (WITHHOLDING.test(msg.text) && !company) {
    flags.push(flag('WITHHELD_IDENTITY', 'declines to name the company and none is on the row', 'warn'));
  }
  if (URGENCY.test(msg.text) && (WITHHOLDING.test(msg.text) || UPFRONT_DEMAND.test(msg.text))) {
    flags.push(flag('PRESSURE_PATTERN', 'urgency combined with withheld detail', 'info'));
  }

  // ── duplicates ───────────────────────────────────────────────────────────
  // Keyed on email only. Name and company are spelled differently by the same
  // person ("Dana Reyes" / "D. Reyes", "BrightCart" / "Bright Cart Inc") and a
  // key built from them would miss the pair entirely.
  if (email.value) {
    const first = seenEmail.get(email.value);
    if (first) flags.push(flag('DUPLICATE_EMAIL', `same address as ${first}`, 'warn'));
    else seenEmail.set(email.value, row.lead_id);
  }

  return { flags, email, budget, ts, msg, company, website, name };
}

export const hasFlag = (flags, code) => flags.some((f) => f.code === code);
export const blocking = (flags) => flags.filter((f) => f.severity === 'block');
