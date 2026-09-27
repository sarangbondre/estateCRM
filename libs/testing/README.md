# libs/testing (`@11e/testing`)

Shared test helpers (F-05, F-17). Infrastructure only: never domain models (CLAUDE.md §3.9).

This release contains the **synthetic data generator** (task F-17): seeded, streaming rows in the 89-column extractor
upload schema (PRD Appendix C), with synthetic people and contacts only. Used by intake/records integration tests,
the QA-02 pilot (sample data only, CR-005), JOU-11 (life curve on 5M subjects) and the REL-02 load tests.

**It never uses real personal data.** Every value is produced from fixed invented lists and the vocabulary; nothing is
read from the client's extractor file. Only the PII-free profile (`docs/inputs/extractor-master-profile.md`) was used,
for proportions.

## Quick start

```sh
pnpm --filter @11e/testing run build

# one 100k-row upload file (strict mode), 2% rejected rows, 8% re-posted ads
pnpm synth --rows 100000 --seed 42 --format xlsx --out /tmp/upload.xlsx --errors 0.02 --repeats 0.08
# writes /tmp/upload.xlsx and /tmp/upload.xlsx.manifest.json
```

```ts
import { SyntheticGenerator, generate, writeDataset, isSyntheticPhone } from '@11e/testing';

const rows = generate({ rows: 500, seed: 7, errorRate: 0.05 }); // in memory, small sets only
for (const { row, meta } of new SyntheticGenerator({ rows: 5_000_000, seed: 1 }).records()) {
  // streaming: one row at a time, constant memory
}
const { manifest } = await writeDataset({ rows: 20_000, seed: 3 }, { format: 'csv', out: '/tmp/pilot.csv' });
```

## Public API

| Export                                                          | What it is                                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTRACTOR_COLUMNS`, `ExtractorRow`, `CellValue`                | The 89 Appendix C columns in PRD order (a test parses the PRD so the list cannot drift). Dates are ISO `YYYY-MM-DD` strings, blank is `null`                                                  |
| `SyntheticGenerator(options).records()`                         | Streaming generator of `{ row, meta }`. `meta`: row number, file index, kind (`ad`/`split`/`repeat`), injected error/warning, repeat source, person index, outside-MMR, expected needs_review |
| `generate(options)`                                             | Same, collected into an array (tests)                                                                                                                                                         |
| `writeDataset(options, { format, out, manifestPath? })`         | Generates and streams to NDJSON / CSV / XLSX, optionally split into files; writes and returns the manifest, elapsed time and rows/s                                                           |
| `NdjsonSink`, `CsvSink`, `XlsxSink`, `createSink`               | The streaming writers (backpressure-aware)                                                                                                                                                    |
| `ManifestBuilder`, `SyntheticManifest`                          | Expected counts (see below)                                                                                                                                                                   |
| `isSyntheticPhone`, `isSyntheticEmail`, `findPhoneLikeNumbers`  | Guards for pilot tooling and tests: assert that no non-synthetic contact is present                                                                                                           |
| `syntheticPhone(n)`, `anonymisedPhone(n)`, `syntheticPerson(i)` | The contact scheme                                                                                                                                                                            |
| `INJECTED_ERROR_CODES`, `resolveOptions`, `Rng`                 | Error codes, option defaults, the seeded PRNG                                                                                                                                                 |

## Knobs (`SyntheticOptions` / CLI flags)

| Option               | CLI                 | Default                  | Meaning                                                                                                 |
| -------------------- | ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `rows`               | `--rows`            | required                 | Data rows                                                                                               |
| `seed`               | `--seed`            | 1                        | Same seed and options → identical output                                                                |
| `errorRate`          | `--errors`          | 0                        | Share of rows with exactly one strict-mode row error (rejected by intake)                               |
| `errorCodes`         | `--error-codes`     | all                      | Which codes to inject (see below)                                                                       |
| `invalidPhoneRate`   | `--invalid-phones`  | 0                        | Share of rows with an unparseable phone (warning `invalid-phone`, row still loads)                      |
| `repeatRate`         | `--repeats`         | 0.13                     | Share of rows that re-post an earlier ad under a new record_id (profile: possible_repeat_of 13%)        |
| `flaggedRepeatShare` | `--flagged-repeats` | 1                        | Share of those that carry `possible_repeat_of`; the rest are unflagged re-posts for records' dedup      |
| `splitRate`          | `--splits`          | 0.34                     | Share of rows that are split children (`parent_record_id`, `split_index` "k of n")                      |
| `outsideMmrRate`     | `--outside-mmr`     | 0.125                    | Share of located rows outside the MMR (profile 228 / 1,821)                                             |
| `whatsappRate`       | `--whatsapp`        | 0                        | Share of WhatsApp-extractor ads (sender_name/phone, text_variants). The profiled file is newspaper only |
| `dateFrom`, `dateTo` | `--from`, `--to`    | 2026-05-01 .. 2026-09-24 | Source date range (weekends weighted, as in the profile)                                                |
| `people`             | `--people`          | rows / 5 (min 50)        | Synthetic people pool (capacity plan ratio: 5M records, 1M people). Max 2,000,000                       |
| `rowsPerFile`        | `--rows-per-file`   | all rows                 | Split into upload-sized files; `{n}` in `--out` or `-NNN` before the extension numbers them             |
| `omitColumns`        | `--omit-columns`    | none                     | Leave columns out of the header: the file then reads as **mapping mode** (`manifest.mode`)              |
| `anonymised`         | `--anonymised`      | false                    | Contacts in the form intake writes with the pilot anonymise switch on                                   |

Format: `--format ndjson|csv|xlsx`, else taken from the `--out` extension. `--manifest <path>` or `-` for none.

### Injected errors (intake LLD §4.4 `RowError.code`)

`value-not-in-list`, `scope-deal-type-mismatch`, `segment-property-type-mismatch`, `market-on-non-sale`,
`side-scope-mismatch`, `required-missing` (blank record_id), `invalid-type`, `invalid-date`, `range-inverted`,
`duplicate-external-ref` (a record_id already loaded earlier **in the same file**). Every error row carries exactly
one error; vocabulary errors are verified with `@11e/vocabulary` at generation time.

## What the rows look like

Distributions follow the extractor profile: 95% Property; Sale 66% / Lease 18% / Sale|Lease 8%; 69% blank market;
Residential 53% / Commercial 25% / Land 11% / Industrial 4%; Supply 94% with ~28% "side defaulted to Supply"
(needs_review 35%); ~60% of areas with blank `area_basis`; 34% split children; times_seen mostly 1; Times of India /
Economic Times; weekend-heavy dates; bank auction notices with deadlines. Localities are MMR micromarkets (Bandra
West, Andheri, Powai, BKC, Lower Parel, Thane, Navi Mumbai, Bhiwandi, MIDC areas, Karjat …) plus outside-MMR cities;
prices come from locality rate bands × property type (Cr/L as written in ads). `raw_text` is composed from the same
unit values (label from `displayLabels`, units, features, contact), so structured fields and text agree. A test
checks 40+ proportions against the profile on 20k rows.

## Synthetic contact scheme

| Kind          | Scheme                                                                                                                                                                               | Check              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Phone         | `+91 L000 NNNNNN`: lead digit L ∈ {9, 8, 7, 6}, then `000`, then six digits (a permutation of the index). Passes Indian-mobile validation (10 digits, first 6–9). Capacity 4,000,000 | `isSyntheticPhone` |
| Second phone  | Index + 2,000,000, so it never equals anyone's first phone                                                                                                                           | `isSyntheticPhone` |
| Anonymised    | `+9100000` + 6 digits (intake anonymise form, never a valid Indian mobile)                                                                                                           | `isSyntheticPhone` |
| Email         | `first.last<index>@example.com` / `@example.in` (RFC 2606); anonymised `u<10 hex>@example.invalid`                                                                                   | `isSyntheticEmail` |
| Name          | Generic first name × surname from two fixed lists                                                                                                                                    | —                  |
| Other contact | `www.<company>.example.com`; anonymised `contact-<8 hex>`                                                                                                                            | —                  |
| RERA number   | `A999` / `P999` + 8 digits (not a MahaRERA district prefix)                                                                                                                          | —                  |

Person #i is a pure function of `i` (not of the seed), so uploads generated with different seeds share people and
exercise phone-based person dedup. **Never dial or message these numbers**: `L000NNNNNN` is a test convention, not a
reserved range. `findPhoneLikeNumbers(text)` + `isSyntheticPhone` lets pilot tooling assert that every phone-like
number in PII/free-text columns is synthetic (apply it to text columns, not to 12-hex ids).

## Manifest

`<out>.manifest.json` (and the return value of `writeDataset`):

- `totals`: rows, `loaded`, `rejected` (injected errors), `needsReview` (extractor flag or blank side on a
  side-bearing scope, intake LLD §4.4), warnings, split children/parents, repeats (flagged/unflagged), rows with a
  city and outside the MMR, WhatsApp rows, `timesSeenOverOne`, distinct people.
- `errors` / `warnings`: count per code.
- `classification`: counts over loaded rows per record_scope, side, deal_type, market, segment, property_type,
  route_to (`(blank)` for blank).
- `columns`, `mode` (`strict` for the full 89 columns, else `mapping`), `files` (row ranges), resolved `options`.

## Recipes

```sh
# QA-02 pilot dataset (CR-005: ≤ 20k rows per file, sample data only), with a few rejected rows
pnpm synth --rows 20000 --seed 2026 --out /tmp/pilot.xlsx --errors 0.01 --whatsapp 0.1

# pilot dataset already in the anonymised form
pnpm synth --rows 20000 --seed 2026 --out /tmp/pilot-anon.xlsx --anonymised

# REL-02 L3: two 100k-row extractor files
pnpm synth --rows 200000 --seed 7 --rows-per-file 100000 --out /tmp/l3-{n}.xlsx

# JOU-11 / REL-02 L4: 5M dataset as 50 upload files of 100k rows (1M people)
pnpm synth --rows 5000000 --seed 5 --rows-per-file 100000 --out /tmp/5m/upload-{n}.csv --people 1000000
```

Throughput (Apple M-series laptop, Node 24): NDJSON ≈ 95k rows/s, CSV ≈ 98k rows/s, XLSX ≈ 12k rows/s; peak RSS
≈ 250–280 MB independent of row count (1M NDJSON/CSV, 300k XLSX measured). 5M CSV ≈ 1 min (≈ 3.2 GB); 5M XLSX
≈ 7 min in 50 files.

## Guarantees

- Deterministic: same options → same rows, ids and manifest. Error injection uses its own random stream, so turning
  errors on does not change the other new-ad rows.
- Every loadable row passes `@11e/vocabulary` (all 23 controlled fields and the cross-field rules); `route_to` =
  `routeFor(scope, side)`; `record_id` unique 12-hex; min ≤ max; valid dates inside the range.
- Split children are consecutive, share `parent_record_id` (never itself a row) and raw_text; an ad never straddles
  files. `possible_repeat_of` always points at an earlier row.
- Constant memory (small ring buffers only); XLSX honours zip backpressure.

## Assumptions

1. **Phones must look valid** (task brief), so they cannot be in a range that is guaranteed unallocated; the `L000`
   block is a convention, detected by `isSyntheticPhone`. Anonymised rows use intake's never-valid `+9100000` form.
2. **Repeats**: the extractor already merges exact/near repeats (times_seen); the 13% `possible_repeat_of` rows are
   generated as separate re-posts (new record_id, later date, often a ±3–5% price change). Unflagged re-posts are
   opt-in (`flaggedRepeatShare < 1`).
3. **Split parents** are not rows (the profile has `parent_record_id` only on children).
4. **Outside MMR** is decided by the generator's locality catalogue; Karjat, Khopoli, Alibag and Panvel are counted
   as MMR (2024 MMR extension); Pune, Nashik, Lonavala, Mahabaleshwar and other states are outside.
5. **Bigha** = 27,000 sq ft (varies by state); other land units use standard conversions.
6. **sale_mode** is only ever Auction (profile) and comes with party_type Bank; Private is never generated.
7. **WhatsApp** defaults to 0% because the profiled master is newspaper-only; sender and text_variants values are
   invented until a sample WhatsApp extractor file is available (PRD OQ-P11).
8. `lead_status` is always `New`; `follow_up_date` and `crm_notes` are blank (as in the profile).
9. `duplicate-external-ref` needs an earlier row in the same file; if there is none, another requested code is used.
10. Publication names are real newspaper titles (public, not personal data); building, company, developer and bank
    names are invented word combinations.
