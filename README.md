# Lead Triage Agent

Submission for [Beat Claude](https://github.com/ericosiu/beat-claude) challenge
**AI Automation Intern 012**, brief version **2026-07**.

Reads `fixtures/inbound_leads.csv` and emits a decision for every row: QUALIFY,
NURTURE, REJECT or ESCALATE, each with a one-sentence reason and a confidence.

Two write-ups, same build:

- [SUBMISSION-011.md](SUBMISSION-011.md) for **Intern 011**, Option B (lead qualification)
- [SUBMISSION.md](SUBMISSION.md) for **AI Automation Intern 012**, which goes deeper on the seeded traps

## Run it

```bash
node src/run.mjs --offline    # deterministic layer only, no API key needed
node tests/check.mjs          # 31 tests on the deterministic layer
```

For a full run, put an OpenRouter key in `.env`:

```
OPENROUTER_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-haiku-4.5
```

```bash
node src/run.mjs              # writes out/decisions.csv, .json, run-log.jsonl
node scripts/compare.mjs      # agent output against evidence/manual_pass.csv
```

No dependencies. Node 22+.

## Layout

```
fixtures/inbound_leads.csv    the challenge fixture, unmodified
src/parse.mjs                 CSV and field normalisation, repairs nothing
src/validate.mjs              twenty structural checks, returns flags only
src/decide.mjs                policy: structural answers first, then guardrails
src/llm.mjs                   judgment layer, lead text passed as data
src/run.mjs                   the loop
tests/check.mjs               31 tests
scripts/compare.mjs           agreement analysis against a manual pass
out/                          decisions and run log from the latest run
evidence/run-1-before-fix/    the run that produced the documented bad output
evidence/manual_pass.csv      my own labels, written before reading agent output
```

## Design in one paragraph

Structural problems get structural answers. A duplicate, an impossible date, an
executable link and an erasure request are facts about a row, so they are settled
by checks that behave the same on every run, and those rows never reach a model.
The model is asked one narrow question about the rows that are left, with the
lead text passed as delimited data rather than as instructions. Guardrails then
compare what it concluded against what the row shows, and anything unresolved
ends at ESCALATE with a reason rather than at a guess.

## Verify the fixture

```bash
shasum -a 256 fixtures/inbound_leads.csv
# cc1927ca771c37b186a2abdb7b9757594da79ec6dda074e5a514dd2761cc8599
```

MIT licensed.
