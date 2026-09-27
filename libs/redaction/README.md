# libs/redaction

PII redaction before any AI call (F-14, ADR-0004, CR-004 / D-8). Every text that goes to the Hugging Face model
(intake free-text classification, insight chat questions) passes through `redact()` first.

Infrastructure only, never domain models (CLAUDE.md §3.9). Pure TypeScript, no dependencies, no I/O, no logging.

## API

```ts
import { redact, restore, detect, hasResidualRisk, containsContact } from '@11e/redaction';

const r = redact('2BHK Powai 1.8 Cr, Flat 1203. Contact Sanjay 90000 01234');
r.text; // '2BHK Powai 1.8 Cr, Flat [UNIT_1]. Contact [NAME_1] [PHONE_1]'
r.counts; // { PHONE: 1, EMAIL: 0, URL: 0, NAME: 1, UNIT: 1, ID: 0 }  (safe to store: insight redaction_counts)
r.mapping; // Map { '[UNIT_1]' => '1203', '[NAME_1]' => 'Sanjay', '[PHONE_1]' => '90000 01234' }  (request memory only)
r.uncertain; // false; true = the intake post-check failed, do not send to the model
```

| Function                 | Purpose                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `redact(text, options?)` | Masks PII with numbered placeholders. Same value → same placeholder within one call.                     |
| `restore(text, mapping)` | Puts originals back (insight: refill action-card payloads for the same user). Unknown placeholders stay. |
| `detect(text, options?)` | The spans (`kind`, `start`, `end`, `value`) without replacing. Values are PII.                           |
| `hasResidualRisk(text)`  | Intake post-check (LLD intake §4.8): a run of ≥ 7 digits or an `@` remains.                              |
| `containsContact(text)`  | Phone or e-mail present (web audit `details` scrub, LLD web §4.6).                                       |

Options:

- `placeholderStyle`: `'square'` → `[PHONE_1]` (default, intake LLD §4.8) or `'angle'` → `⟨PHONE_1⟩` (insight LLD §4.1).
- `kinds`: subset of `PHONE | EMAIL | URL | NAME | UNIT | ID` (default all). listings uses `['PHONE', 'EMAIL']`.
- `allowTerms`: localities, micromarkets, vocabulary values and building names that must never be masked as NAME.
- `replacer(detection, placeholder)`: insert something else, e.g. intake's consistent HMAC fakes (LLD intake §4.9).

Existing placeholders are never re-masked and new numbers continue after them, so `redact(redact(x).text).text` equals
`redact(x).text`. **The `mapping` holds PII**: keep it in request memory, never store, log or send it. It is a `Map`, so
an accidental `JSON.stringify` of the result prints `{}`.

## What is masked

| Kind    | Examples                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PHONE` | `+91 90000 01234`, `091…`, `0091…`, `0 9000 001166`, `90000-01234`, `9000.012.345`, `9 0 0 0 0 1 2 3 4 5`, `9OOOO 1O234` (O for zero), `(022) 2000 0789`, `022-20001699`, 8-digit Mumbai landlines, 7-digit numbers after `Tel/Ph/Call`, toll-free `1800…`, `…12345/46` and `/35/36` alternate endings, Devanagari digits `९०००० ०१२३४`.                                                                 |
| `EMAIL` | `a.b@example.com`, `a @ example.in`, `a at example dot com`, `a[at]example[dot]in`, `a(at)example.com`, `a{at}example.com`.                                                                                                                                                                                                                                                                              |
| `URL`   | `https://…`, `www.…`, `wa.me/91…`, `api.whatsapp.com/…`, `t.me/…`, bare domains on common TLDs.                                                                                                                                                                                                                                                                                                          |
| `NAME`  | Only **next to a contact cue**: honorifics (`Mr/Mrs/Ms/Dr/Shri/Smt/Adv`), contact phrases (`contact`, `call`, `ph`, `mob`, `owner`, `broker`, `agent`, `from`, `regards`, `attn`, `sampark (kara/karein)`, `posted by`, …), right before/after a phone or e-mail (`Sanjay 90000…`, `… 90000 01234 (Priya)`, lower-case `sanjay 90000…`), `-bhai/-ji/-saheb/-sir` suffixes, Devanagari `संपर्क/श्री/मो.`. |
| `UNIT`  | `Flat 1203`, `Flat No. A-503`, `B/702`, `Shop No. 5`, `Office #804`, `Unit 601-602`, `Gala 5-B`, `Plot No. W-45`, `Survey No. 45/2`, `Gat No. 112`, `A Wing`, `Wing C 1104`, `B-wing 702`, bare `No. 12`, address-leading `1203, Sai Darshan Tower`.                                                                                                                                                     |
| `ID`    | PAN, GSTIN, Aadhaar (4-4-4), other bare runs of 9–18 digits (bank accounts) unless preceded by a currency word.                                                                                                                                                                                                                                                                                          |

## What is kept (the model needs it)

Localities, micromarkets, building/society/project names (`Sai Krupa CHS`, `Lodha Amara`), company names
(`Sai Estate Agency`), prices (`1.25 Cr`, `45L`, `Rs 72,00,000`, `12500000/-`), areas and ranges (`4000 sqft`,
`2000-2500 sqft`), BHK, floors (`12th floor`, `Floor 12 of 20`), dates and year ranges, pincodes, RERA ids
(`P51800012345`, public business data), extractor `record_id`s and display codes (`DEM-000127`, `INV-000045`),
highway codes (`NH-4`).

## Test set

`tests/fixtures/ads.ts`: 171 synthetic ads with PII (newspaper, WhatsApp forwards, demand ads, commercial/industrial,
auction notices, obfuscations, Hinglish/Marathi/Devanagari, chat questions), each annotated with the exact PII spans,
plus 50 PII-free hard negatives. All values are invented: phones use synthetic patterns (`90000 0xxxx`, `022-2000 0xxx`),
e-mails use `example.com`/`example.in`. The tests assert:

- **0 leaks**: no annotated value survives verbatim, no phone's last 7 digits survive even with separators removed or
  O-for-zero, no name word or unit token survives on a word boundary;
- every listed non-PII token survives, and every hard negative comes back byte-identical;
- idempotency in both placeholder styles; the residual post-check passes except for texts keeping a literal `@`;
- 10,000 redactions in under 2 s (≈ 0.2 s locally).

## Assumptions (privacy-safer choices where the LLDs differ or are silent)

1. Placeholder style differs between LLDs (intake `[PHONE_1]`, insight `⟨PHONE_n⟩`): both are supported, square is the default.
2. `ID` is an extra kind (PAN/GSTIN/Aadhaar/long digit runs); not in the LLD list, but personal data.
3. Wing letters are masked even without a unit number (conventions §9: unit / wing are PII-sensitive).
4. Floors are **kept** (the model needs them), although conventions §9 lists "exact floor" as PII-sensitive; the unit number is masked.
5. RERA ids are kept (public business data; intake §4.9 keeps `rera_number`). They still trip `hasResidualRisk` (≥ 7 digits),
   so such rows go to review, as the intake LLD says.
6. Survey/Gat/CTS/plot numbers are masked as `UNIT` (exact address).
7. Over-redaction is accepted near contact cues (e.g. `Contact Logistics Manager …` masks "Logistics").

## Known limitations

- A name with **no contact cue** is not masked ("Rakesh wants a 2BHK"). insight marks stored text `PII-possible` for this reason.
- A surname that is also a common English or place word after a cue (`Mr. Ram More`, `Contact Anand Nagar`) may be kept
  partly or wholly; add such words' exceptions carefully.
- Numbers written as words (`nine eight two…`) and phones split across lines are not detected.
- 7-digit numbers are phones only after a contact cue; bare 7-digit runs are left for `hasResidualRisk` to catch.
- `@` used as "at the rate of" (`@ Rs 22/sqft`) stays and makes `uncertain` true (the LLD post-check is literal).
- Names in scripts other than Latin/Devanagari are not handled.

## Adding patterns

1. Add a failing case to `tests/fixtures/ads.ts` (`PII_ADS` with its PII spans and the tokens to keep, or `CLEAN_ADS`
   for a false positive). Use invented values only.
2. Fix the detector in `src/detectors/` (`phone.ts`, `contact.ts`, `unit.ts`, `name.ts`) or the word lists in
   `src/lexicon.ts` (`NON_NAME_WORDS` stops a word being masked as a name; `NON_PERSON_SUFFIXES` marks building/company names).
3. `pnpm --filter @11e/redaction test`: 0 leaks and 0 changed hard negatives are required.
