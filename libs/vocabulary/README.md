# libs/vocabulary (`@11e/vocabulary`)

Controlled vocabulary **release v0.6** (BRD v0.6 §4.2, PRD Appendix C, CR-003, CR-006), R-11 validators,
generated display labels and the legacy-term translation table (task F-13).

Infrastructure only (CLAUDE.md §3.9): typed `as const` lists and pure functions. No I/O, no database, no
dependencies. Services never store labels and never filter on them (BRD §4.2).

## Public API

| Export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | What it is                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOCABULARY_VERSION` (`'0.6'`), `VOCABULARY_RELEASE_ID` (`'v0.6'`)                                                                                                                                                                                                                                                                                                                                                                                                                    | Release version (the id is the one in `vocabulary.released.v1`)                                                                                                                                                              |
| `RECORD_SCOPES`, `SIDES`, `DEAL_TYPES`, `PROPERTY_DEAL_TYPES`, `MARKETS`, `SEGMENTS`, `PROPERTY_TYPES_BY_SEGMENT`, `PROPERTY_TYPES`, `LAND_USES`, deal tags (`SALE_MODES`, `TENANCY_STATUSES`, `TENURES`, `AGREEMENT_FORMS`, `POSSESSION_STATUSES`, `FURNISHINGS`), non-property (`SECTORS`, `INCLUDES_PROPERTY_VALUES`, `PARTICIPANT_ROLES`, `SIGNAL_TYPES`), upload enums (`PARTY_TYPES`, `ROUTE_TO_VALUES`, `AREA_BASES`, `LAND_AREA_UNITS`, `SALE_RATE_UNITS`, `SOURCE_CHANNELS`) | The lists, in exact BRD spelling, with matching union types (`RecordScope`, `DealType`, `PropertyType`, …)                                                                                                                   |
| `FIELDS`, `VOCABULARY_FIELDS`, `VocabularyField`, `FieldValue<F>`                                                                                                                                                                                                                                                                                                                                                                                                                     | The 23 controlled fields of the strict-mode upload schema (intake LLD §4.4), keyed by their snake_case / `x-vocabulary` name, with `multi` for pipe lists (`deal_type`, `property_type`)                                     |
| `RECORD_SCOPE_RULES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Per scope: allowed deal types, allowed sides, "Routed to"                                                                                                                                                                    |
| `DISPLAY_LABEL_TABLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The seven rows of the BRD display label table, verbatim                                                                                                                                                                      |
| `matchKey(raw)`, `isBlank(raw)`                                                                                                                                                                                                                                                                                                                                                                                                                                                       | R-11 key (trim, collapse whitespace, case-fold); blank test                                                                                                                                                                  |
| `canonicalValue(field, raw)`, `isValidValue(field, raw)`                                                                                                                                                                                                                                                                                                                                                                                                                              | R-11 match of one value                                                                                                                                                                                                      |
| `parseValue(field, raw)`, `parseList(field, raw)`, `parseField(field, raw)`                                                                                                                                                                                                                                                                                                                                                                                                           | Strict-mode parse: canonical value (`null` / `[]` for blank) or `issues[]`. Never throws                                                                                                                                     |
| `validateClassification(raw)`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | record_scope, deal_type, market, segment, property_type, land_use and side together: per-field R-11, then the cross-field rules. Returns canonical values + `needsReview` / `reviewDetails` (`side_missing`), or every issue |
| `segmentOfPropertyType(type)`, `routeFor(scope, side)`                                                                                                                                                                                                                                                                                                                                                                                                                                | Helpers (route as a `route_to` value)                                                                                                                                                                                        |
| `displayLabel(input)`, `displayLabels(classification)`                                                                                                                                                                                                                                                                                                                                                                                                                                | Generated For / Wants label per deal type, with parties and the table row used                                                                                                                                               |
| `LEGACY_TERMS`, `translateLegacyTerm(field, raw)`, `legacyKey(raw)`                                                                                                                                                                                                                                                                                                                                                                                                                   | Mapping-mode translation (canonical values pass through; pipe lists translated item by item)                                                                                                                                 |
| `LEGACY_FIELD_NAMES`, `translateLegacyFieldName(header)`, `LEGACY_ROLE_NAMES`                                                                                                                                                                                                                                                                                                                                                                                                         | BRD §16 legacy field and role names                                                                                                                                                                                          |
| `releaseContent()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The release in the `VocabularyRelease` shape of `records.yaml` (`version`, `fields` with `bySegment` for property_type, `recordScopes`, `legacyTerms`, `displayLabels`). records adds checksum, status and activatedAt       |

Issue codes are the intake `RowError.code` values of the contract: `value-not-in-list`, `scope-deal-type-mismatch`,
`segment-property-type-mismatch`, `market-on-non-sale`, `side-scope-mismatch`.

```ts
import { validateClassification, displayLabels } from '@11e/vocabulary';

const result = validateClassification({
  recordScope: 'property',
  dealType: 'Sale|Lease',
  market: 'secondary',
  segment: 'Residential',
  propertyType: 'Apartment',
  side: 'Supply',
});
if (result.ok) displayLabels(result.value).map((l) => l.text); // ['Resale, For Sale', 'For Rent']
```

## Changing the vocabulary

The vocabulary is read-only in the app (PRD D-16). Adding, removing or renaming a value is a **change to the standard,
owned by Vinit and Priyanka**, shipped to the CRM and both extractors together.

1. Get the change approved (BRD change, and a CR in `docs/change-requests/` if approved documents change).
2. Add a new release file `src/release-v<next>.ts` (never edit a released file), and point `index.ts` at it.
3. Bump the version: **minor** (`0.6` → `0.7`) for any added, removed or renamed value or rule; there is no patch
   level for vocabulary content. records ships the matching `services/records/vocabulary/v<next>.json` from
   `releaseContent()` and a data migration for removed values (records LLD §4.13).
4. Update the tests (the label tests transcribe the BRD table independently of the lib).

## Assumptions (BRD is silent or ambiguous; most literal reading taken)

1. **R-11 whitespace:** besides trimming, runs of whitespace inside a value collapse to one space (as in the intake
   `legacy_terms.term_norm` rule). Case-folding is `toLowerCase()`. Hyphen variants ("Semi-Furnished") are not
   matched in strict mode.
2. **Pipe lists:** duplicates are removed keeping the first order; an empty item (`Sale|`) is `value-not-in-list`.
3. **Sale with a blank market** (69% of the extractor file, CR-006 Z-10) is not a row of the label table. Supply →
   "For Sale" (parties "Seller and Buyer"); Demand → "Wants to Buy" (parties "Buyer", as Sale, Any).
4. **Lease with a blank segment** → "For Lease" / "Wants to Lease" ("Rent" is only for Residential).
5. **Labels exist only for record_scope = Property** with side Supply or Demand and a Property deal type. Business,
   Capital, Equipment, Market Participant and Market Signal records get no generated label.
6. **Supply with market Any** has no label (empty BRD cell) and is rejected as `value-not-in-list` on `market`
   (Any is "Demand only"); the contract has no dedicated error code for it.
7. **market with a blank deal_type** is `market-on-non-sale` (deal_type does not include Sale). market on a
   non-Property Sale (e.g. Equipment) is accepted: the BRD only says "Sale only".
8. **property_type with a blank segment** is accepted; the segment is not inferred (use `segmentOfPropertyType`).
9. **land_use** is validated against its list but not restricted to the Land segment (the BRD says Land records carry
   it, not that others cannot).
10. **Blank side** needs review on every scope except Market Participant and Market Signal, including a blank
    record_scope.
11. **Legacy translation:** "Pre-leased"/"Preleased" → deal_type Sale + tenancy_status Tenanted (glossary
    "Preleased"); "Leave and License" → Lease + agreement_form Leave and License (glossary); "Auction" → sale_mode
    Auction only; "1 RK"/"1RK" → Studio + bhk 0.5 (PRD D-17); spaces around "/" are ignored in legacy terms
    ("Lease / Rent"). Pattern terms such as "2BHK Flat" are left to intake's translator (not a fixed table term).
    Pipe lists whose items disagree on another field (e.g. `Resale|New project`, two markets) are untranslatable.
12. "Lead" (BRD §16: deferred) has no translation.
