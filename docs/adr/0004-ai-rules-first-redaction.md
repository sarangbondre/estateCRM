# ADR-0004: AI: rules first, redaction, Hugging Face open-weight models, "the model plans, the service executes"

- Status: Accepted (Stage 3 approved 2026-09-24)
- Date: 2026-09-24 (revised: Hugging Face models, per the product owner)

## Context
- PRD D-8: no personal data to third-party AI.
- The product owner wants **Hugging Face inference models**, with chat answers **scoped to the CRM's own data, never
  the outside world**.
- Vercel can't host models. Phase 1a runs on free plans (CR-005).
- Vinit's extractor files arrive already classified (strict mode), so AI is needed only for mapping-mode free text and for chat.
- R7: inference cost.

## Options
1. **Rules + open-weight models on Hugging Face, on redacted text only. For chat the model returns a query plan and never answers from its own knowledge.**
2. Self-hosted open-weight models on our own GPU. Not possible on Vercel. The target after the AWS move.
3. A proprietary hosted LLM API. Not chosen (product owner preference).
4. No AI. Rejected by the product owner.

## Decision
Option 1.
- **Hosting path:**
  - Phase 1a: Hugging Face **Inference Providers** using the free monthly credits.
  - Once paid: a **dedicated Hugging Face Inference Endpoint** (private, no data retention). Region: India if offered,
    otherwise the nearest (CR-004).
  - After the AWS move: the same model self-hosted in Mumbai.
- **Models** (open-weight instruct models, exact choice and size in Stage 4 against the M5 and M7 benchmarks):
  - a small model for classifying leftover free text;
  - a mid-size model with reliable JSON output for chat query planning.
- **Intake:**
  1. Rules and dictionaries run first (units, localities, BHK, legacy terms, phone and email extraction).
  2. Only unresolved rows are redacted and sent to the model.
  3. The output is validated against the controlled vocabulary. Anything invalid or low-confidence gets needs_review.
- **Chat, scoped to our data:**
  1. The question is redacted.
  2. The model returns a JSON query plan chosen from an allowed catalogue (filters, grouping, sorting, matches, exports).
  3. insight validates the plan and runs it on its read model.
  4. The answer is built **only from query results** and always shows "How I got this".
  5. Questions outside the CRM's data ("what is the repo rate?") get a clear "I can only answer from 11 Estates data".
  6. The model never sees records and never writes free-form facts into the answer.
- **Redaction** is a shared `libs/` component: regexes for Indian phone numbers and emails, name-near-contact-phrase
  masking, unit-number patterns. It's covered by its own test set.

## Consequences
- PII never leaves our systems. Answers are always grounded (R5). Cost scales with unresolved rows and chat use only.
- Free credits are small. When they run out, intake falls back to needs_review and chat to keyword filters, and the UI says so.
- Model quality must be proven on the M5 and M7 benchmarks in Stage 4 before a model is fixed.
