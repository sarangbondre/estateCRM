# Input: extractor master file profile (`crm_master.xlsx`)

| | |
|---|---|
| Source | `crm_master (1).xlsx`, shared by Sarang on 2026-09-24 (Vinit's newspaper extractor output) |
| Contents | Sheet **Leads**: 2155 records × 89 columns. Sheet **run_log**: 1 run. Sheet **migration_map**: 2,128 old→new ID mappings |
| Run | 2026-09-24 12:57, "migration v3→v4" from `crm.db` listings: 2,090 ads read → 2,155 records; 737 split children; 146 exact and 255 near repeats merged; 206 possible repeats flagged; 766 needs_review; 599 side defaulted; 0 validation errors |
| Privacy | **The file contains real names, phone numbers and emails from newspaper ads.** It is **not** stored in the repo. This profile shows no personal values. |

Values shown only for controlled or numeric columns. Free-text and PII columns show fill rate only.

## CRM working columns (maintained by hand today)

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `lead_status` | 100% | text | New (2155) |
| `follow_up_date` | 0% | — |  |
| `crm_notes` | 0% | — | *(free text / PII: not shown)* |
| `route_to` | 99% | text | Supply Team (1977), Demand Team (43), Network (43), Business Desk (37), Capital Desk (13), Archive (12), Watchlist (6) |

## Review

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `needs_review` | 100% | bool | False (1389), True (766) |
| `review_reason` | 36% | text | 115 distinct; top: side defaulted to Supply (463), side defaulted to Supply; deal type not stated (97), deal type not stated (16), side unclear (16), property type not stated (12) |

## Identity and splits

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `record_id` | 100% | text | 12-hex id, e.g. `da724e14fa03` |
| `parent_record_id` | 34% | text | 12-hex id, e.g. `a0d22fc061a8` |
| `split_index` | 34% | text | 46 distinct; top: 2 of 2 (169), 1 of 2 (169), 3 of 3 (51), 2 of 3 (51), 1 of 3 (51) |

## Classification (BRD §4.2)

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `record_scope` | 100% | text | Property (2044), Market Participant (43), Business (37), Capital (13), Equipment (12), Market Signal (6) |
| `deal_type` | 95% | text | Sale (1415), Lease (383), Sale\|Lease (165), JV (27), Sale\|JV (23), Equity (7), Partnership (5), Project Funding (4), Sale\|Partnership (3), Pagdi (3), Lease\|Partnership (2), Distribution (2), Sale\|Lease\|JV (2), Asset Sale (1) |
| `market` | 31% | text | Secondary (541), Primary (111), Any (19) |
| `segment` | 93% | text | Residential (1152), Commercial (543), Land (226), Industrial (93) |
| `property_type` | 93% | text | 50 distinct; top: Apartment (991), Office (239), Commercial Space (125), Land Parcel (107), Plot (103) |
| `property_detail` | 100% | text | 1276 distinct; top: Apartment (390), Office (106), Bungalow (19), Shop (18), Showroom (15) |
| `land_use` | 5% | text | Industrial (28), NA (24), Agricultural (19), Residential (10), Mixed (10), Commercial (9) |
| `side` | 99% | text | Supply (2027), Demand (55), None (49) |
| `side_evidence` | 97% | text | *(free text / PII: not shown)* |

## Deal tags

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `sale_mode` | 6% | text | Auction (123) |
| `deadline_date` | 4% | date | 53 distinct; top: 2026-07-06 00:00:00 (7), 2026-08-24 00:00:00 (4), 2026-08-19 00:00:00 (4), 2026-07-31 00:00:00 (4), 2026-09-23 00:00:00 (3) |
| `tenancy_status` | 2% | text | Tenanted (41), Vacant (11) |
| `tenure` | 1% | text | Leasehold (18), Freehold (9) |
| `agreement_form` | 2% | text | Leave and License (48) |
| `is_jodi` | 2% | bool | True (34), False (2) |
| `possession_status` | 16% | text | Ready (277), Under Construction (46), Available From (23), Under Redevelopment (4) |
| `possession_date` | 1% | text | 2026-05 (8), 2026-06 (6), 2026-12 (3), 2026-07 (3), 2027 (2), 2026-09-01 (1), 2027-01-15 (1), 2026-08 (1), 2026-09 (1), 2027-02 (1), 2027-12 (1) |
| `furnishing` | 12% | text | Furnished (214), Semi Furnished (26), Unfurnished (13), Bare Shell (7) |

## Non-property

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `sector` | 2% | text | Manufacturing (13), Food and Beverage (9), Hospitality (8), Real Estate (5), Education (4), Healthcare (3), Technology (2), Other (2), Agriculture (2), Distribution (1), Media (1) |
| `includes_property` | 1% | text | Yes (16), No (3) |
| `business_description` | 4% | text | *(free text / PII: not shown)* |
| `participant_role` | 2% | text | Broker (36), Auctioneer (2), Consultant (2), Architect (2), Developer (1) |
| `signal_type` | 0% | text | Redevelopment Upcoming (4), Government Tender (1), Land Policy (1) |

## Project

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `project_name` | 16% | text | *(free text / PII: not shown)* |
| `developer_name` | 3% | text | *(free text / PII: not shown)* |

## Configuration and features

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `bhk_min` | 40% | float,int | 3 (309), 2 (206), 4 (182), 1 (78), 5 (45), 2.5 (13), 6 (10), 7 (9), 3.5 (8), 8 (5), 4.5 (3), 0.5 (1) |
| `bhk_max` | 40% | float,int | 3 (319), 4 (198), 2 (184), 1 (59), 5 (55), 2.5 (14), 6 (11), 3.5 (10), 7 (9), 8 (5), 4.5 (4), 0.5 (1) |
| `features` | 90% | text | *(free text / PII: not shown)* |

## Location

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `locality` | 79% | text | 626 distinct; top: Bandra West (66), Andheri West (56), Juhu (38), Khar West (37), Worli (37) |
| `city` | 85% | text | 65 distinct; top: Mumbai (1380), Navi Mumbai (88), Thane (54), Pune (53), Karjat (18) |
| `state` | 90% | text | Maharashtra (1825), Gujarat (19), Goa (17), Tamil Nadu (11), Rajasthan (10), West Bengal (8), Karnataka (8), Chandigarh (8), Uttar Pradesh (7), Delhi (5), Andhra Pradesh (5), Himachal Pradesh (4), Haryana (3), Telangana (3) |
| `landmark` | 26% | text | *(free text / PII: not shown)* |
| `location_text` | 99% | text | *(free text / PII: not shown)* |

## Area

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `area_sqft_min` | 50% | float,int | 432 distinct; top: 2000 (30), 1100 (21), 3000 (21), 2500 (19), 600 (19) |
| `area_sqft_max` | 50% | float,int | 436 distinct; top: 2000 (26), 1500 (20), 2500 (19), 1100 (18), 3000 (18) |
| `area_basis` | 19% | text | Carpet (389), Builtup (24), Saleable (1) |
| `land_area_value` | 10% | float,int | 122 distinct; top: 5 (11), 1 (11), 2 (10), 10 (7), 3.5 (6) |
| `land_area_unit` | 10% | text | acre (117), sqft (40), sqm (35), sqyd (7), gunta (7), bigha (3) |
| `land_area_sqft` | 10% | float,int | 135 distinct; top: 217800 (11), 43560 (10), 87120 (10), 435600 (7), 152460 (6) |
| `area_text` | 66% | text | *(free text / PII: not shown)* |

## Price

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `price_text` | 39% | text | *(free text / PII: not shown)* |
| `sale_price_inr_min` | 29% | int | 257 distinct; top: 120000000 (18), 30000000 (15), 60000000 (14), 20000000 (13), 35000000 (13) |
| `sale_price_inr_max` | 28% | int | 250 distinct; top: 30000000 (15), 150000000 (13), 60000000 (12), 140000000 (11), 35000000 (11) |
| `sale_rate_inr` | 2% | int | 30000000 (4), 21000 (4), 25000 (3), 20000 (2), 4000000 (2), 1500000 (2), 45000 (2), 6000 (1), 25000000 (1), 20000000 (1), 110000000 (1), 1000000 (1), 2000000 (1), 2200000 (1) |
| `sale_rate_unit` | 2% | text | sqft (18), acre (16), sqyd (1), sqm (1) |
| `price_negotiable` | 4% | bool | True (77) |
| `rent_monthly_inr_min` | 5% | int | 58 distinct; top: 350000 (8), 250000 (7), 800000 (5), 70000 (5), 150000 (4) |
| `rent_monthly_inr_max` | 5% | int | 58 distinct; top: 250000 (7), 350000 (6), 800000 (5), 70000 (5), 100000 (3) |
| `rent_rate_psf` | 0% | — |  |
| `deposit_inr` | 1% | int | 3000000 (2), 414000 (2), 57000 (1), 100000 (1), 2100000 (1), 25500000 (1), 360000 (1), 400000 (1), 6000000 (1), 450000 (1), 50000 (1) |
| `deposit_months` | 0% | int | 6 (4) |
| `current_rent_inr` | 1% | int | 150000 (4), 1700000 (2), 518000 (2), 336000 (2), 200000 (1), 1000000 (1), 236000 (1), 1200000 (1), 2181000 (1), 470000 (1), 95000 (1), 410000 (1), 1800000 (1), 250000 (1) |
| `yield_pct` | 0% | float,int | 5.5 (2), 6 (1), 7 (1) |

## Contact (PII)

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `contact_name` | 26% | text | *(free text / PII: not shown)* |
| `company_name` | 27% | text | *(free text / PII: not shown)* |
| `party_type` | 37% | text | Broker (428), Owner (171), Bank (92), Developer (45), Society (25), Company (16), Government (13) |
| `phones` | 93% | text | *(free text / PII: not shown)* |
| `whatsapp_phone` | 2% | text | *(free text / PII: not shown)* |
| `emails` | 9% | text | *(free text / PII: not shown)* |
| `rera_number` | 2% | text | *(free text / PII: not shown)* |
| `other_contact` | 5% | text | *(free text / PII: not shown)* |

## Source

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `source_channel` | 100% | text | Newspaper (2155) |
| `source_name` | 100% | text | Times of India (1323), Economic Times (580), Mumbai Mirror (107), Business Standard (52), Mid-Day (51), Financial Express (20), Free Press Journal (11), The Hindu (3), Hindustan Times (2), Navbharat Times (2), Business Line (2), Gujarat Samachar (2) |
| `source_edition` | 100% | text | Mumbai (2145), Pune (7), Ahmedabad (2) |
| `source_supplement` | 0% | text | Bombay Times (5) |
| `source_date` | 100% | date | 105 distinct; top: 2026-05-24 00:00:00 (142), 2026-05-03 00:00:00 (109), 2026-08-02 00:00:00 (91), 2026-05-30 00:00:00 (85), 2026-09-05 00:00:00 (80) |
| `source_page` | 100% | int | 8 (620), 6 (414), 10 (413), 12 (211), 14 (94), 16 (67), 9 (46), 4 (43), 3 (41), 2 (40), 1 (38), 18 (28), 21 (14), 7 (14) |
| `source_files` | 100% | text | *(free text / PII: not shown)* |

## Repeats (extractor dedup)

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `first_seen_date` | 100% | date | 105 distinct; top: 2026-05-24 00:00:00 (142), 2026-05-03 00:00:00 (109), 2026-08-02 00:00:00 (91), 2026-05-30 00:00:00 (85), 2026-09-05 00:00:00 (80) |
| `last_seen_date` | 100% | date | 107 distinct; top: 2026-05-24 00:00:00 (140), 2026-05-03 00:00:00 (89), 2026-05-30 00:00:00 (87), 2026-09-05 00:00:00 (75), 2026-07-05 00:00:00 (71) |
| `times_seen` | 100% | int | 1 (1865), 2 (199), 3 (56), 4 (22), 5 (8), 6 (2), 8 (2), 7 (1) |
| `possible_repeat_of` | 13% | text | 12-hex id, e.g. `dae9dff1a36a` |

## Extraction

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `raw_text` | 100% | text | *(free text / PII: not shown)* |
| `source_language` | 88% | text | English (1886), Gujarati (2) |
| `ocr_used` | 100% | bool | True (1868), False (287) |
| `extraction_confidence` | 94% | float | 0.8 (228), 0.85 (225), 0.72 (172), 0.75 (128), 0.6 (127), 0.78 (114), 0.9 (113), 0.5 (100), 0.7 (99), 0.55 (91), 0.82 (90), 0.68 (80), 0.65 (77), 0.87 (59) |
| `extractor_notes` | 60% | text | *(free text / PII: not shown)* |

## WhatsApp only (empty in this newspaper file)

| Column | Fill | Type | Values (top) |
|---|---|---|---|
| `sender_name` | 0% | — | *(free text / PII: not shown)* |
| `sender_phone` | 0% | — | *(free text / PII: not shown)* |
| `text_variants` | 0% | — | *(free text / PII: not shown)* |

## Findings for Stage 4
See `docs/change-requests/CR-006.md`.
