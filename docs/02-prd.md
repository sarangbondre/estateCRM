# 02 — Product Requirements Document (PRD)

| | |
|---|---|
| Project | 11 Estates CRM (estateCRM) |
| Version | 0.7 |
| Date | 2026-09-30 |
| Based on | `docs/01-brd.md` v0.6 (approved 2026-09-24 via CR-003); worked scenarios from `docs/inputs/vinit-journeys-artifact.md` |
| Status | APPROVED 2026-09-24; v0.7 (CR-005, CR-006, CR-012) re-approved 2026-09-30 (frozen; changes via Change Request) |

### Change log
| Version | Change |
|---|---|
| 0.1–0.3 | Drafts against BRD v0.3 (broker roles, single Listing model, chat-first UI). |
| 0.4 | Rewritten for BRD v0.5 (CR-002): demand and supply teams, Property/Project/Offer/Demand/Person model, status axes, life curve, publication levels, call queues, journeys to Closed, many-to-many matching with bundles, manual entry, three dashboards. Chat-first kept, with a "My queue" panel added. Vinit's scenarios added as acceptance scenarios (Appendix B). |
| 0.5 | Updated for BRD v0.6 (CR-003): the standard deal vocabulary (record_scope → deal_type → market → segment → property_type → side), Land segment, deal tags, generated labels, party_type; non-property desks (Business, Capital, Archive, Network, Watchlist); two intake modes with row-level validation; review queue by review_reason; classification dashboards and side checks; read-only vocabulary; field dictionary (Appendix C). |
| 0.5.1 | CR-005 (2026-09-24): new §8.4, the Phase 1a pilot on free plans with temporary NFR relaxations and a paid-plan gate. |
| 0.6 | CR-006 (2026-09-24): aligned with Vinit's extractor master file. Appendix C is now the exact 89-column upload schema. Area is a range plus a basis. Source ads with split records. Extractor dedup trusted, with possible repeats sent to review. Idempotent master re-uploads with migration maps. Review reason codes. Outside-MMR flag. CRM working columns ignored. Pilot anonymise switch. Unknown market. |
| 0.7 | CR-012 (2026-09-30): Appendix C gains optional `building_name` and `floor` (91 columns; strict mode accepts the 89-column files of older extractor versions too). `crm_notes` is imported as a note on the record instead of being ignored. Proposal feedback gains "maybe" (neutral). CR-011: residential matching allows ±1 BHK. |

### Decisions for this PRD
| # | Decision | Source |
|---|---|---|
| D-1 | **Both teams see all data.** Queues are personal, but no offer or demand is hidden from 11 Estates staff. Viewing contact details is audit-logged. | OQ-10, 2026-09-24 |
| D-2 | **Matching runs across all data.** Each match is visible to everyone and owned by the demand's owner. | follows D-1 |
| D-3 | Chat, exports and dashboards follow the same visibility (everything within the organisation). | 2026-09-23 |
| D-4 | **Publishing within the ceiling:** the supply team sets the publication level (Private / Anonymous / Public) within the BRD §4.6 ceiling. There is no manager approval step. An automatic privacy scan is a **blocking check** before Anonymous or Public. | CR-002 X-3 |
| D-5 | Photos come from calls and visits, from the source (WhatsApp shares), and from image links in uploaded sheets. They attach to the Property, and an Offer can choose which ones to use. | BRD OQ-15 |
| D-6 | **Website shows locality only.** Building names appear only in proposals to qualified clients. | BRD A-11, CR-001 withdrawn |
| D-7 | Staff sign in with Google. Only invited accounts can sign in. | 2026-09-23 |
| D-8 | No personal data is sent to third-party AI providers. | 2026-09-23 (answers part of BRD OQ-9) |
| D-9 | **Chat-first UI** with interactive cards and a side panel. A **My queue** panel is the daily work list. The assistant proposes changes and a person confirms them. | 2026-09-24, CR-002 X-4 |
| D-10 | **Daily call capacity is set per person** by a Manager (default 40). The day's list fills with Must call first and tops up from Should call. | OQ-20 |
| D-11 | **Proposals are shared as a PDF and/or a private share link** (expiring). Staff send them through their own WhatsApp or email. The system sends nothing. | OQ-22 |
| D-12 | **Life curve for the open categories** (BRD OQ-19). Industrial (any deal): Fresh ≤ 45, Ageing ≤ 90, Stale ≤ 120. **Land and JV:** 60 / 120 / 180. **Pagdi:** same as Sale, Secondary (supply 45 / 90 / 120, demand 45 / 90 / 150). Expired after the last value. All editable by Admin. | OQ-19, CR-003 Y-2 |
| D-13 | Phase 1 intake is **file upload + manual entry** only. WhatsApp (n8n) and Meta webhooks shown in Vinit's artifact are next phase. | CR-002 X-7 |
| D-14 | **Desks.** Everyone can view the Business Desk, Capital Desk, Archive, Network and Watchlist. **Managers** own the Business and Capital desks (review, assign, archive). **Watchlist follow-up tasks go to the supply team.** A Business record with includes_property = Yes also creates a Property that enters Should call. | OQ-10, CR-003 Y-3 |
| D-15 | **Two intake modes.** Files whose header matches the standard schema use **strict mode**: out-of-list values are rejected row by row, and needs_review rows are loaded into the review queue. Other files use **mapping mode**: columns are mapped, legacy terms are translated with the BRD §4.2 "absorbs" table, and anything that can't be translated is set to needs_review. | CR-003 Y-5 |
| D-16 | **The vocabulary is read-only in the app.** Controlled lists are versioned reference data. Changes come through a request owned by Vinit and Priyanka and ship to the CRM and both extractors together. | BRD §4.2, CR-003 Y-7 |
| D-17 | Hotels and resorts are Commercial property types; 1 RK is stored as property_type Studio with bhk 0.5; Pagdi is kept as a deal type. | BRD OQ-25/26/27, CR-003 Y-4 |

---

## 1. Purpose and scope

This PRD turns BRD v0.6 into product behaviour: roles, records, journeys, screens (chat cards and panels), user
stories with acceptance criteria, functional and non-functional requirements. Scope is exactly BRD §11. The BRD is the
source of truth for business rules. This document cites BRD sections instead of repeating them where possible.

---

## 2. Roles and permissions

### 2.1 Roles
| Role | Who | Summary |
|---|---|---|
| **Admin** | Owner / IT | Everything, plus users, settings, reference data, API keys, audit log |
| **Manager** | Runs the business or a team | Everything a team member can do, plus reassigning work, setting call capacity, undoing merges, overriding exits, dashboards for all |
| **Demand agent** | Demand team (e.g. Priyanka) | Works demand: quick add, understand, qualify, match, sourcing requests, proposals, site visits, In process, exits |
| **Supply agent** | Supply team (e.g. Vinit) | Works offers: call queues, contact, verify, qualify, publication levels, Add supply, projects and price sheets |
| **Data operator** | Staff who upload (may sit in either team) | Uploads files, maps templates, works review queues |
| **Website client** | System (11 Estates website, project microsites) | Read-only Listings API, published items only |

A user has one role. A Data operator permission can be added to an agent (A-15).

### 2.2 Visibility (D-1)
- **R-VIS-1** Every record belongs to one organisation (tenant). There is never cross-tenant access (BRD G7).
- **R-VIS-2** All staff see all Properties, Projects, Offers, Demands, People, Matches and Deals in their organisation.
- **R-VIS-3** Personal details (names, phones, emails, unit-level address) are shown to staff, but each view of a contact
  is audit-logged. Exports that include contact columns are audit-logged with row counts.
- **R-VIS-4** The Website client sees only published offers, projects and anonymous demand posts, at their publication
  level, and only the public fields (§8.3).

### 2.3 Permission matrix
| Capability | Admin | Manager | Demand agent | Supply agent | Data operator |
|---|:-:|:-:|:-:|:-:|:-:|
| View all records | ✔ | ✔ | ✔ | ✔ | ✔ |
| Upload files, map templates | ✔ | ✔ | ✔ | ✔ | ✔ |
| Review queues (unclassified, uncertain merges, price gaps) | ✔ | ✔ | — | — | ✔ |
| Undo a merge | ✔ | ✔ | — | — | — |
| Quick add demand; demand journey actions | ✔ | ✔ | ✔ | — | — |
| Add supply; supply journey actions; call outcomes | ✔ | ✔ | — (Add supply from own demand ✔) | ✔ | — |
| Set publication level | ✔ | ✔ | — | ✔ | — |
| Confirm / reject matches, build bundles | ✔ | ✔ | ✔ | ✔ (view, suggest) | — |
| Proposals, site visits, deals | ✔ | ✔ | ✔ | ✔ (site visit, supply-side notes) | — |
| Exits (Lost / Dormant / Invalid) | ✔ | ✔ | ✔ | — | — |
| Retire offer (Inactive) | ✔ | ✔ | — | ✔ | — |
| Reassign owner / queue items | ✔ | ✔ | — | — | — |
| Set call capacity | ✔ | ✔ | — | — | — |
| Dashboards | all | all | all | all | data quality |
| Chat, export | ✔ | ✔ | ✔ | ✔ | ✔ |
| View desks (Business, Capital, Archive, Network, Watchlist) | ✔ | ✔ | ✔ | ✔ | ✔ |
| Work Business / Capital desks (review, assign, archive) | ✔ | ✔ | — | — | — |
| Close Watchlist follow-up tasks | ✔ | ✔ | — | ✔ | — |
| Settings, users, API keys, audit log | ✔ | — | — | — | — |
| Change the controlled vocabulary | — (by versioned release only, D-16) | — | — | — | — |

---

## 3. Information model (business view)

Records and vocabulary follow BRD v0.6 §4.1–4.2 exactly. **Field names are the BRD's snake_case names**, and the full
list is in Appendix C. This section lists what the UI and requirements use.

### 3.1 Classification (every record)
record_scope, side (Supply / Demand / None), side_evidence, needs_review, review_reason, source type, capture mode, tenant.
Property-scope records add deal_type, market (Sale only), segment and property_type. Labels ("For Rent", "Wants to Buy,
New Project") are **generated from these fields, never stored** (BRD §4.2 display labels). Filters and reports always
use the stored fields.

### 3.2 Property (PRP)
segment (Residential / Commercial / Industrial / Land), property_type (controlled per segment; several pipe-separated),
property_detail (descriptive words such as Luxury or Duplex), land_use (Land only), locality, city, state, micromarket
(derived), **building/society (private: proposals only)**, landmark, wing/unit/floor (private), total floors,
built_up_area_sqft, carpet_area_sqft, bhk (residential), amenities, photos (origin: call, visit, source share, sheet
link), sources (second sources with price and a price-gap flag), sightings, people (with party_type).

### 3.3 Project (PRJ)
Sale, Primary only. Developer (Person, party_type Developer), name, locality/micromarket, **project RERA number
(required before publishing)**, possession, amenities, floor plans, dated price sheets (the latest drives the life
curve), unit configurations as Offers (property_type + bhk_min/bhk_max + unit count).

### 3.4 Offer (INV)
Exactly **one deal_type** per Offer (Sale, Lease, JV or Pagdi). A Sale|Lease supply record is one Property with two Offers.
- market (Sale: Primary / Secondary).
- Prices: sale_price_inr_min/max, rent_monthly_inr_min/max, current_rent_inr (tenanted), deposit_inr.
- **Deal tags:** sale_mode, deadline_date, tenancy_status, tenure, agreement_form, is_jodi, possession_status,
  **possession_date** (the Available from date), furnishing, price_negotiable.
- Revenue share with a partner broker (text + %). Unit count (projects).
- **Status axes** (BRD §4.4):
  - Record: Captured → Enriched → Contacted → Verified → Qualified.
  - Publication: Private / Anonymous / Public.
  - Commercial: Upcoming, Available, Matched, In proposal, Site visit, In process, Closed, Inactive.
  - Signals: enquiries, matches and sightings counters.
- **Life curve:** last confirmed (date + how), last seen, day count, stage. Category keys follow BRD §4.5 plus D-12.
- Queue state: Must call / Should call rank, attempts, next call. Tags: "Sourced for DEM-…", lease-renewal Upcoming.

### 3.5 Demand (DEM)
side = Demand. deal_type (one or more), market (Primary / Secondary / Any, Sale only), segment, property_type (one or
more), micromarkets/localities (multi), budget_inr_min/max or rent_monthly_inr_min/max, area_sqft_min/max (built up or
carpet stated), bhk_min/max, move-in timing, **deal tags the client states** (e.g. tenancy_status = Tenanted for a
preleased buyer, sale_mode = Auction), client and decision maker, introducing broker + shared-commission note, touches
with first-touch flag.
- **Status axes:**
  - Record: Captured → Enriched → Verified → Qualified.
  - Publication: Private / Anonymous (demand post, "Wants" label).
  - Commercial: New, Contacted, Active, Sourcing, Matched, Proposal shared, Site visit, In process, Closed.
  - Exit: Lost / Dormant / Invalid, with reason, competing terms and revisit date.
- Life curve as for offers. Owner: a demand agent.

### 3.6 Non-property records (stored and viewable, no journeys; D-14)
| Record | Key fields | Lives in |
|---|---|---|
| Business (BIZ) | deal_type (Sale, Lease, Partnership, Distribution), side, sector, includes_property, business_description; linked Property when includes_property = Yes | Business Desk |
| Capital (CAP) | deal_type (Equity, Debt, Project Funding, Asset Sale), side, sector, business_description | Capital Desk |
| Equipment (EQP) | deal_type (Sale, Lease), side, business_description | Archive |
| Market Participant | A Person with participant_role (Broker, Developer, Auctioneer, Architect, PMC, Consultant, Lender) | Network (People directory) |
| Watchlist item (WCH) | signal_type (Redevelopment Upcoming, Government Tender, Land Policy, Title Notice), party_type, deadline_date, follow-up task (supply team) | Watchlist |

### 3.6a Source ads, splits and repeats (CR-006 Z-3, Z-4)
- A **source ad** is one uploaded ad (raw_text, source_name, edition, date, page, language, OCR flag, confidence). One ad can hold
  **1..n records**, linked by `parent_record_id` + `split_index`. Split children are never merged with each other automatically.
- The extractor's own repeat handling is trusted: `times_seen`, `first_seen_date` and `last_seen_date` update the record's
  last seen. `possible_repeat_of` becomes an **uncertain-merge review item**. The CRM still dedups across sources and
  against records already in the CRM.
- Records whose city is outside Mumbai/MMR carry an **outside-launch-area flag**. They're visible in search and
  dashboards, but excluded from queues, matching and listings (Z-7).
- `area_sqft_min/max` + `area_basis` (Carpet / Builtup / Saleable / blank) replaces separate built-up and carpet fields.
  Land keeps `land_area_value/unit/sqft` (Z-2).

### 3.7 Other records
| Record | Key fields |
|---|---|
| Person | Name, phones (normalised), emails, company, **party_type** (Owner, Broker, Developer, Company, Bank, Society, Government), participant_role (if a Market Participant), flags (Invalid, broker-posing-as-client, unwilling, anonymous-shares-only), dependencies ("selling INV-x to buy DEM-y"). Party roles in labels: Seller/Buyer, Developer/Buyer, Landlord/Tenant, Landowner or Society/Developer, Outgoing/Incoming tenant. |
| Enquiry (ENQ) | Source export, campaign / form / listing / project ID, name, phone, message, date, linked Offer/Project, resulting Demand or touch |
| Touch | Demand, source type, capture mode, source detail, date, first-touch flag |
| Match (MAT) | Demand, one Offer or a **bundle** of Offers, score + factor breakdown, status (Suggested / Confirmed / Rejected / Closed with reason), flags (reconfirm, price above budget), exclusion reason (e.g. "Available too late") |
| Sourcing request (SRQ) | Demand, requested by, assigned supply agent, due date, priority, status, offers added |
| Proposal (PROP) | Demand, options, format (PDF / link), link expiry, sent on, client feedback per option |
| Site visit | Demand, offer(s), date/time, attendees, outcome, preferred option |
| Deal (DEAL) | Demand, offer, agreed terms, stage (Negotiation / Documentation / Stamp duty & registration / Closed / Cancelled), **next action + follow-up date (required)**, cancellation reason |
| Raw record / sighting | Upload, row number, original values, linked record |
| Market data point | Property/locality, price, date, source (closed by us, closed elsewhere, reported), notes |
| Upload | File, intake mode (strict / mapping), source type, uploader, template, counts, row errors, status |

### 3.8 Reference data
- **Controlled vocabulary** (BRD §4.2): versioned, read-only in the app (D-16). Includes the legacy-term translation
  table used by mapping mode.
- Mumbai (MMR) **micromarket hierarchy**: zone → micromarket → locality → sub-locality, with aliases (e.g. Andheri East
  contains Chakala, Marol, MIDC).
- Life-curve thresholds per category (BRD §4.5 + D-12), editable by Admin.

---

## 4. Journeys (behaviour)

Business rules are in BRD §4.4–§7. This section defines how the product carries them out.

### 4.1 Life curve engine
- Runs on every confirmation event (call outcome "confirmed", site visit, price sheet) and daily at 02:00 IST.
- A confirmation resets the day count to 0. A sighting updates last seen only.
- On a stage change it applies the automatic actions in BRD §4.5:
  - Ageing: adds a reconfirm to Should call, or to the demand queue for a demand.
  - Stale: downgrades Public to Anonymous and stops new match suggestions for the demand.
  - Expired: unpublishes the offer and excludes it from matching, or moves the demand to Dormant.
- Upcoming offers start counting 60 days before Available from. Projects count from the latest price sheet.
  Dormant demand is paused until its revisit date.

### 4.2 Supply call queues (BRD §5.2)
- **Must call:** offers with an enquiry or a new confirmed or suggested match. Due within 24 h of the enquiry upload.
- **Should call:** new captures (proactive vetting) and reconfirmations. Ranked by freshness, demand gap (open demand
  in the category and micromarket minus matching supply), source quality and price band. Weights are tunables.
- **Today's list per person** = Must call (all, oldest due first) + Should call up to their daily capacity (D-10).
- **Call outcome** is required after each call:
  - Confirmed: resets the life curve and allows edits to price, availability and areas.
  - No answer: counts an attempt. After 3 attempts the person is marked unreachable (A-37).
  - Already gone: the offer becomes Inactive and the price goes to market data if known.
  - Unwilling: kept for intelligence and never published.

### 4.3 Demand queues (BRD §8)
To contact, To qualify, Reconfirm due, In sourcing, Sourcing requests open, Open matches (to confirm), Proposals out
(awaiting feedback), Site visits this week, In process with follow-up due (overdue at the top), Dormant revisits due today.

### 4.4 Handoffs (BRD §6.2)
- Sourcing request (demand → supply) with due date and priority. It appears in the assignee's queue.
- Match notification to the demand owner.
- Proposal, visit and In process status shown on the offer for the supply owner.
- When an offer closes, all other matched demands are notified and their matches close with the reason "Leased/Sold to
  another client". When a demand exits, the matched offers' owners are notified and their matches are released.

### 4.5 Matching engine (BRD §7)
- **Hard filters:**
  - opposite side, same record_scope (Property);
  - offer deal_type ∈ the demand's deal_types;
  - market: the demand's Any matches Primary and Secondary;
  - same segment, and offer property_type ∈ the demand's property_types;
  - deal tags the client stated must match (e.g. tenancy_status = Tenanted, sale_mode);
  - micromarket overlap (the hierarchy counts, e.g. Chakala is inside Andheri East);
  - possession_date within the demand's window, otherwise excluded with the reason;
  - Residential: offer BHK within ±1 of the demand's BHK (4BHK → 3–5BHK; exact BHK scores highest) (CR-011);
  - a single match needs the offer's area within tolerance; smaller commercial/industrial units appear only in bundles (CR-011);
  - offer not Expired, Closed or Inactive; demand not Stale and not exited.
- **Unknowns (CR-006):** a blank `area_basis` is compared with a wider tolerance and shows an "area basis unknown" flag. A blank `market` on a supply Sale is compatible with any demand market and shows a "market unknown" flag.
- **Scored:** micromarket proximity, price vs budget (the right price field for the deal_type), area like with like
  (built up vs built up, carpet vs carpet), bhk range, timing, furnishing and must-haves. The weights are tunables, initially set from the PRD v0.3
  factors and tuned from feedback (M6).
- **Bundles:** for commercial and industrial demand, the engine suggests combinations of 2–3 offers in the same
  building or micromarket whose combined area meets the requirement and whose combined price is within budget (A-38).
- It re-runs on: a new or changed offer or demand, a price change (flags "price above budget"), a close or exit, and a
  life-curve change.
- Matches are suggestions. People confirm them. Nobody is contacted automatically.

### 4.6 Publication (BRD §4.6, D-4)
- The **ceiling is computed**:
  - Private: always allowed.
  - Anonymous: allowed while Fresh or Ageing.
  - Public: needs Verified, real photos, and Fresh or Ageing.
  - Closed, Inactive and Expired offers are forced to Private.
- The supply agent picks a level at or below the ceiling. The system automatically lowers the level when the ceiling
  drops (Stale → Anonymous, Expired → Private).
- **Blocking privacy scan** before Anonymous or Public: phones, emails, URLs, building/society names, wing/unit numbers
  in the title and description; text detected on photos is a warning. The public description is auto-generated from
  fields and sanitised, and staff can edit it.
- **Labels:** listings show generated labels (e.g. "For Rent", "New Project, For Sale"), never stored values or legacy terms.
- **RERA:** the 11 Estates MahaRERA agent number is on every listing (from settings). Sale, Primary listings require the
  project RERA number.
- **Anonymous demand posts** (during sourcing) show the "Wants" label, segment, property_type, micromarket, area range,
  budget band and timing. They are taken down when the demand is matched or exits.

---

## 5. User interface (chat-first + My queue)

### 5.1 Principles (unchanged from v0.3, extended)
- **The chat is home.** Every function is reachable by typing, by "/" quick actions or by sidebar shortcuts. Results come
  back as interactive cards. Larger views open in the side panel (D-9).
- **R-CHAT-1:** nothing changes until a person clicks a button on a card, and permissions are re-checked on the click.
- **R-CHAT-2:** every data answer is grounded in a real query and shows "How I got this".
- **R-CHAT-3:** cards show live state.
- **R-UI-4 (new): My queue is always one click away.** Queue work is list-driven, so **My queue** is a first-class panel:
  - pinned in the sidebar with counts;
  - opened by "/queue" or the home tile;
  - each item opens its record with the right action card (log call outcome, qualify, confirm match, follow up).
- Desktop-first. Tablet and phone usable, with the side panel full-screen on phones.

### 5.2 Layout
```
┌──────────────┬──────────────────────────────────────┬─────────────────────────┐
│ Sidebar      │ Conversation                         │ Side panel (on demand)  │
│ + New chat   │  assistant text + cards              │  My queue / record /    │
│ My queue  24 │                                      │  table / dashboard /    │
│ Dashboards   │                                      │  proposal builder       │
│ Quick add    │ ┌──────────────────────────────────┐ │                         │
│ Upload       │ │ (clip) Ask, or type / …     Send │ │                         │
│ Recent chats │ └──────────────────────────────────┘ │                         │
│ Priya · Dem ⚙│                                      │                         │
└──────────────┴──────────────────────────────────────┴─────────────────────────┘
```

### 5.3 Home
- A greeting plus **Today** tiles for the signed-in role:
  - Demand agent: To contact, Reconfirm due, Open matches, Follow-ups overdue.
  - Supply agent: Must call, Should call (today), Sourcing requests, Stale Public offers.
  - Manager: team queues and life-curve health.
- The composer and suggestions sit below the tiles.

### 5.4 Card and panel catalogue
| ID | Card / panel | Appears when | Main actions | Roles |
|---|---|---|---|---|
| C-01 | Today tiles | Home | Click → opens the queue section | all |
| C-02 | Answer + How I got this | Any question | Expand | all |
| C-03 | Table card | Data questions | Excel, Open in panel, row → record panel | all |
| C-04 | Attach / Mapping / Progress → Report | Upload | Start processing, review follow-ups | all |
| C-05 | Review cards, **grouped by review_reason** (e.g. side unclear, scope unclear, value not in list, uncertain merge, price gap) | "/review" | Set the field from controlled dropdowns; Merge / Different / Skip; accept price. Review never blocks routing (BRD §4.7) | Admin, Mgr, Op |
| C-06 | **Quick add** | "/add demand", "/add supply", or "new requirement from …" | Phone first → dedup result → **side** (asked first for usability) → deal_type → market (only for Sale) → segment → property_type (filtered by segment) → bhk, area, budget, locality, optional deal tags. Controlled dropdowns only; prefilled from the typed text → **Create** | Demand, Supply, Mgr |
| C-07 | **Add supply** | From a demand or SRQ, or "/add supply" | Prefilled from the demand; property-level dedup first → **Create offer** (tagged Sourced for DEM, matched on creation) | Supply, Demand (own demand), Mgr |
| C-08 | **Call outcome** | Opening a queue item or "called Sanjay about INV-00452" | Confirmed (edit price/availability/areas) / No answer / Already gone / Unwilling; add an offer on the same property; next call date | Supply, Demand, Mgr |
| C-09 | **Qualify demand** | After the first call | Checklist: decision maker, budget confirmed, timing confirmed, agrees to work with 11 Estates → **Mark qualified** → inventory check runs | Demand, Mgr |
| C-10 | **Matches** (incl. bundles) | "/matches", after qualify, new offer | Confirm / Reject (with reason) / Build bundle; reconfirm and price flags shown | Demand, Mgr (Supply views) |
| C-11 | **Sourcing request** | No match at inventory check, or "source supply for DEM-…" | Create SRQ (assignee, due, priority), toggle anonymous demand post → Confirm | Demand, Mgr |
| C-12 | **Publication** | On an offer, or "publish INV-…" | Shows the ceiling and why, privacy scan, RERA check; choose Private / Anonymous / Public | Supply, Mgr |
| C-13 | **Proposal** | "send proposal for DEM-…" | Pick options → preview → **Generate PDF / share link** → mark sent (logged) | Demand, Mgr |
| C-14 | **Site visit** | "schedule visit…" | Date, offers, attendees → outcome afterwards (resets both life curves) | Demand, Supply, Mgr |
| C-15 | **Deal** | "start deal DEM-… with INV-…" | Stage, agreed terms, **next action + follow-up date (required)**, cancel (returns offer to Available and demand to Active) | Demand, Mgr |
| C-16 | **Exit** | "client postponed…", "mark lost/invalid" | Lost (reason, competing terms), Dormant (revisit date), Invalid (reason, flag person) → Confirm | Demand, Mgr |
| C-17 | **Close / retire offer** | Deal closed, or "INV-… is gone" | Closed (price → market data; notify other demands) / Inactive; auto-create Upcoming renewal for 11-month leases | Supply, Demand, Mgr |
| C-18 | **Project price sheet** | Upload a developer sheet, or "/project" | Create or update configurations, units and prices; flag matches over budget | Supply, Mgr |
| C-19 | Confirm card | Any proposed bulk change (reassign, capacity, settings) | Confirm / Cancel | per action |
| C-20 | Dashboard summary | "/dashboard", "how are we doing" | Open demand / supply / other scopes / data-quality dashboard | all |
| C-21 | **Desk item** | "/desks", or a Business / Capital / Watchlist record | Business/Capital: assign, archive, open linked Property. Watchlist: follow-up task (owner, due), done | view: all; act: Mgr (desks), Supply (Watchlist) |
| P-01 | **My queue panel** | Sidebar, "/queue", tiles | Sections per §4.2 / §4.3; each item → record + action card; drag to reorder is not allowed (rank is computed) | all agents |
| P-02 | Offer panel | Row click, "open INV-…" | Tabs: Overview (status axes, life curve, ceiling), Property & other offers, Sources & sightings, Matches, Enquiries, Photos, Activity | all |
| P-03 | Demand panel | "open DEM-…" | Tabs: Overview (status axes, life curve), Touches, Matches, Sourcing, Proposals & visits, Deal, Activity | all |
| P-04 | Person panel | Click a person | Roles, flags, linked offers and demands, dependencies, call history | all |
| P-05 | Project panel | "open PRJ-…" | Configurations, units, price sheets, RERA, enquiries, matches | all |
| P-06 | Dashboards panel | Sidebar | Demand / Supply / Data quality tabs (BRD §8); every tile opens the list | all |
| P-07 | Table panel | Open in panel | Filter on stored fields, sort, select, bulk reassign (Mgr), export | all |
| P-08 | **Desks panel** | Sidebar "Desks" | Tabs: Business Desk, Capital Desk, Archive (Equipment), Network (Market Participants), Watchlist (deadlines in 14 days first) | all |
| Page | Settings | Gear | Users & roles, capacities, life-curve thresholds, queue and match weights, micromarkets, templates, RERA number, API keys, audit log; **Vocabulary (read-only, shows the version)** | Admin (capacities: Mgr) |

### 5.5 Wireframes (low fidelity)

**My queue (supply agent)**
```
┌ My queue · Vinit · capacity 40 · 31 planned today ──────────────────────────┐
│ MUST CALL (4)                                              due              │
│  INV-00452 Office, Andheri E · 5,000 sqft · ₹8L  enquiry   in 6 h    [Open] │
│  INV-00612 Office, Marol · Sourced for DEM-000127  SRQ-014 today     [Open] │
│ SHOULD CALL (27 of 212)                                    rank             │
│  INV-00488 2BHK, Andheri W · ₹75K · new · demand gap 12      4       [Open] │
│  INV-00391 Office, Marol · Public · Ageing day 31 · reconfirm 9       [Open] │
│ SOURCING REQUESTS (2)  SRQ-014 DEM-000127 due Fri · SRQ-015 …               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Call outcome card**
```
 You: called Sanjay about INV-00452, available, 8.5L, owner will also sell for 11 Cr
 ┌ Call outcome · INV-00452 ────────────────────────────────────────────────┐
 │ (•) Confirmed  ( ) No answer  ( ) Already gone  ( ) Unwilling            │
 │ Rent ₹8,50,000/mo (was ₹8L)   Available: now   Built up 5,000 sq ft      │
 │ + Add sale offer on PRP-00210: ₹11 Cr  [x]                               │
 │ Life curve resets to day 0 · Record → Contacted                          │
 │                                       [Cancel]  [Save outcome]           │
 └──────────────────────────────────────────────────────────────────────────┘
```

**Demand panel (overview)**
```
┌ DEM-000127 · Wants to Lease · Office · Andheri E / Marol ──────────── ✕ ─┐
│ Record    Captured ─ Enriched ─ Verified ─ [Qualified]                    │
│ Commercial New ─ Contacted ─ Active ─ [Matched] ─ Proposal ─ Visit ─ …    │
│ Life curve  Day 2 · Fresh (Lease, Commercial: Ageing at 31)                │
│ 5,000–7,000 sq ft built up · ₹8–10 L/mo · move in ≤ 60 days · CFO signs   │
│ Touches: Channel via Anil (first) · Digi via Meta lead ad                 │
│ Matches (3): INV-00452 92 · INV-00455 88 · Bundle INV-00461+62 84          │
│ [Send proposal]  [Schedule visit]  [Exit…]                               │
└───────────────────────────────────────────────────────────────────────────┘
```

**Publication card**
```
┌ Publication · INV-00452 ──────────────────────────────────────────────────┐
│ Ceiling: PUBLIC (Verified · 14 real photos · Fresh day 3)                 │
│ ( ) Private   ( ) Anonymous   (•) Public                                  │
│ Privacy scan  ✔ no phone/email  ✔ no building name  ✔ no unit number      │
│ RERA          ✔ MahaRERA A51800012345 shown                               │
│ Public text: "Furnished office, 5,000 sq ft built up, Andheri East …"     │
│                                               [Cancel]  [Set to Public]   │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 6. User stories and acceptance criteria

### 6.1 Ingestion (Module A)
**US-01** As a Data operator, I want to upload .xlsx/.xls/.csv files of up to ~100k rows (newspaper sheets, WhatsApp
exports, lead-form and enquiry exports, broker and builder sheets), so that every source gets in.
- AC1 Up to 150k rows / 50 MB per file (A-19). Multi-sheet selection. Identical re-uploads are detected.
- AC2 Source type (Channel / Digi / Direct) and source detail are set at upload. Digi exports must map a campaign, form,
  project or listing ID column when one exists.
- AC2a **Intake mode (D-15).** A header that matches the standard schema selects **strict mode**. Rows with values
  outside the controlled lists are rejected with an error naming the field and value. needs_review rows load and
  appear in the review queue. Any other header selects **mapping mode**, where legacy terms are translated and
  untranslatable values set needs_review.
- AC3 Processing runs in the background: Parsing → Normalising → Classifying → Deduplicating → Matching. A 100k-row file
  finishes in ≤ 30 min (M2).
- AC4 The report shows read = new + linked (sightings/second sources/touches) + review + unclassified + rejected.
  Rejected rows are downloadable.
- AC5 Raw rows are kept unchanged and every record links to its sightings.

**US-02** As a Data operator, I want column mapping suggestions and saved templates, so that repeat sources need no mapping.

**US-03** As a Manager, I want to see time since the last upload per source, so that enquiries don't sit in exports
(R10, A-17). The data-quality dashboard shows a warning when a Digi source is > 24 h old.

### 6.2 Manual entry (Module A)
**US-04** As a Demand agent, I want **quick add** that asks for the phone number first, so that I find an existing
client or demand instead of creating a duplicate.
- AC1 Phone lookup shows matching Person(s), their open demands and flags (e.g. Invalid) before any form appears.
- AC2 Free text ("Rohan from a fintech needs 5–7k sqft office Andheri E, 8–10L, 2 months, referred by Mr Shah") prefills the form.
- AC3 The source type is Direct, capture mode is "typed in", and a referrer can be linked.

**US-05** As an agent, I want **Add supply** from a demand or sourcing request, so that found supply is matched immediately.
- AC1 The form is prefilled from the demand. The property-level duplicate check runs before creation.
- AC2 The new offer starts at Contacted, is tagged "Sourced for DEM-…", is matched on creation, and is queued for
  verification at top priority.

**US-06** As an agent, I want to update records after calls and visits (outcome, availability, price, areas, photos), so
that the life curve and status stay true (C-08, C-14).

### 6.3 Deduplication
**US-07a (CR-006 Z-5)** As a Data operator, I want to re-upload the extractor master at any time without creating duplicates.
- AC1 Rows are **upserted by `record_id`**. Unchanged rows do nothing, and changed rows update facts and last seen.
- AC2 If the workbook has a `migration_map` sheet, it is applied first: kept = re-key, merged = reversible merge into the target, split = re-point to the children. CRM work (calls, stages, matches, notes) follows the new ID.
- AC3 A re-upload never deletes CRM records that are missing from the file.
- AC4 `lead_status` and `follow_up_date` are ignored (the CRM owns them). `crm_notes` becomes a note on the record (CR-012). `route_to` is kept as the extractor's suggestion (Z-8).
- AC5 `review_reason` text is kept, and a **reason code** is derived for grouping: side_defaulted, deal_type_missing, side_unclear, property_type_missing, other (Z-6).

**US-07** Supply dedup at property level (building, floor, area, locality). A phone number never decides alone. A
matching post from another broker is linked as a **second source** with its price, and a **price gap** is flagged
when prices differ by more than 5% (A-39). Reposts become sightings and update last seen.

**US-08** Demand dedup on phone, company and requirement similarity across sources. A match becomes a **touch** on the
existing demand, and the first touch keeps the credit (A-16). Uncertain cases go to review.

**US-09** Uncertain merges are never silent. Every merge can be undone by a Manager, restoring records, touches,
sightings and matches. (M3 ≥ 95%, M4 ≥ 85%.)

### 6.4 Categorisation and extraction
**US-10** Each row is classified in the BRD order: record_scope → deal_type → market → segment → property_type → side
(with side_evidence), plus source type. Attributes go into the named fields (locality, building, property_type, bhk_min
and bhk_max, areas, price or rent, deal tags). Non-Property scopes are routed to their desk, directory or Watchlist.
Low-confidence rows carry needs_review and a review_reason. Blank means unknown; placeholders like "Unknown" are never
stored. (M5 ≥ 90%, measured on side + segment + deal_type.)

**US-10a** As a Manager, I want a Side check on the data-quality dashboard (records where side defaulted to Supply, per
run), so that I can see when the extractor phrase list needs new entries (R15).

### 6.5 Life curve
**US-11** As a team, we want every live offer and demand to show its life-curve stage and day count, with the automatic
actions in BRD §4.5, so that nothing stale is published or chased.
- AC1 Thresholds per category from BRD §4.5, and Industrial per D-12. Admin-editable.
- AC2 Confirmation events reset to day 0. Sightings do not.
- AC3 Upcoming offers start 60 days before Available from. Projects follow the latest price sheet. Dormant pauses.
- AC4 Stage changes perform their actions within 5 minutes of the event and are logged in Activity.

### 6.6 Supply journey
**US-12** As a Supply agent, I want today's call list (Must call then Should call, up to my capacity), so that I call the
right people first. (§4.2, P-01.)
- AC1 Must call items show the reason (enquiry / match / SRQ) and a 24 h due time. Overdue items are red and on top.
- AC2 Should call shows rank and reason (new, demand gap, reconfirm, stale Public).
- AC3 A call outcome is mandatory to clear an item. No answer reschedules it. The 3rd no answer marks the person
  unreachable (A-37).

**US-13** As a Supply agent, I want to add further offers on the same property (sale next to lease), so that each has its
own price, life curve and matches but shares photos and verification.

**US-14** As a Supply agent, I want to verify (real photos, details) and qualify (terms, revenue share) an offer, so that
Public unlocks and the source is committed.

**US-15** As a Supply agent, I want to set the publication level within the ceiling, with a blocking privacy scan and
RERA check (§4.6, C-12). (M8 = 0.)

**US-16** As a Supply agent, I want Upcoming offers with an Available from date, including the automatic Upcoming
renewal offer at month 10 of every 11-month lease 11 Estates closes.

**US-17** As a Supply agent, I want to create a Project from a developer price sheet with configuration offers and unit
counts, update it from new sheets (prices, units), and reduce units on booking. (C-18.)

**US-18** As a Supply agent, I want to retire an offer (already gone → Inactive, price to market data; unwilling → never published).

### 6.7 Demand journey
**US-19** As a Demand agent, I want my demand queues (§4.3), so that I know whom to call and what's overdue.

**US-20** As a Demand agent, I want to record the first call (requirement, budget, timing, locations, decision maker)
and qualify the demand (C-09), after which the inventory check runs automatically.

**US-21** As a Demand agent, I want to confirm or reject suggested matches, including bundles, with reasons. (M6 ≥ 60%.)

**US-22** As a Demand agent, when nothing matches, I want to raise a sourcing request to the supply team and optionally
post the demand anonymously (C-11). The post comes down when a match is confirmed.

**US-23** As a Demand agent, I want to build a proposal from confirmed matches and share it as a **PDF and/or private link**
(D-11).
- AC1 Includes photos, built-up and carpet area, price, availability, **building names** and the MahaRERA number. Never
  includes owner or broker contacts.
- AC2 Share links expire after 14 days (A-40) and record opens.
- AC3 "Mark sent" logs date and channel. The system sends nothing (BRD out of scope).

**US-24** As a Demand agent, I want to schedule site visits and record outcomes. A visit resets both life curves.

**US-25** As a Demand agent, I want to run a deal through In process with a required next action and follow-up date,
with overdue deals at the top of my queue. (R13.)
- AC1 Stages: Negotiation → Documentation → Stamp duty & registration → Closed. Cancel returns the offer to Available,
  the demand to Active, and keeps the failed deal.

**US-26** As a Demand agent, I want to exit a demand as Lost (reason, competing terms → market data), Dormant (revisit
date, default 60 days, A-41) or Invalid (reason; flag the person). Matches are released and the offers' owners notified.

**US-27** As a Demand agent, I want to close a deal. The offer closes, its other matched demands are notified and return
to matching, and the closing price is kept as market data.

### 6.8 Matching
**US-28** Matching per §4.5: many-to-many, bundles, date-aware exclusions with reasons, reconfirm flags on Stale offers,
price-change flags, and close propagation. Each match shows score and factor breakdown.

**US-29** New confirmed or suggested matches notify the demand owner in-app and put the offer into Must call when it is
not yet Contacted (A-42).

### 6.9 Dashboards
**US-30** Demand, Supply, **Other scopes** and Data-quality dashboards with the tiles in BRD v0.6 §8:
- classification grids (segment × deal_type, with Sale split by market) shown with For / Wants labels;
- deal-tag filters (e.g. Auction, Tenanted);
- desks, Archive, Network and Watchlist counts;
- side checks and rejected-value counts.

Every tile opens the underlying list. Filters: period, segment, deal_type, market, property_type, micromarket, owner.
Loads in ≤ 2 s p95.

### 6.10 Chat
**US-31** As any user, I want to ask in plain English or Hinglish and get grounded answers, tables and Excel downloads.
- AC1 Covers records, queues, life curve, matches, deals and market data ("average closed rent for offices in Marol this
  quarter").
- AC2 It can propose any action in §5.4, but applies only on click (R-CHAT-1).
- AC3 Correctness ≥ 85% on the benchmark (Appendix A, M7).

### 6.11 Export
**US-32** Background Excel export (≤ 100k rows) from any list or chat answer, with a 24 h link, audit-logged.

### 6.12 Listings API
**US-33** As the 11 Estates website and project microsites, I want offers, projects and anonymous demand posts at their
publication level, so that I can display them.
- AC1 Anonymous: generated label, locality, area, price, availability, "details subject to confirmation", with no
  photos. Public: plus photos and the other public fields (§8.3). All four segments are served.
- AC2 Every item carries the 11 Estates MahaRERA number. Project items carry the project RERA number.
- AC3 Filters, cursor pagination (max 50), a change feed (published / downgraded / withdrawn since t), API key per site, rate limit.
- AC4 Items are withdrawn or downgraded within 1 minute of a close, retire, Stale or Expired event.

### 6.13 Administration and audit
**US-34** Admin manages users, roles, capacities (Managers too), life-curve thresholds, queue and match weights,
micromarkets, templates, the RERA number and API keys.
**US-36** As any user, I want the Business Desk, Capital Desk, Archive, Network and Watchlist as list views, so that
non-property records are kept and findable (BRD scope 9).
- AC1 Managers can assign, archive or open the linked Property of Business and Capital items.
- AC2 Watchlist items create a follow-up task for the supply team. Deadlines within 14 days show first.
- AC3 These records never enter matching, queues or the Listings API.

**US-37** As an Admin, I want to see the controlled vocabulary and its version (read-only), so that everyone uses the same
values as the extractors (D-16).

**US-35** Immutable audit log of contact views, exports, merges and undos, publication changes, exits, deal closes and
setting changes, kept ≥ 1 year.

---

## 7. Functional requirements

| ID | Area | Requirement | Stories |
|---|---|---|---|
| FR-ING-1 | Ingestion | Upload, mapping, templates, background processing, report, lineage | US-01, US-02 |
| FR-ING-2 | Ingestion | Source freshness monitoring | US-03 |
| FR-ING-3 | Ingestion | Strict and mapping intake modes; row-level validation against the controlled lists; legacy-term translation | US-01 |
| FR-ENT-1 | Entry | Quick add with phone-first lookup and text prefill | US-04 |
| FR-ENT-2 | Entry | Add supply from demand or SRQ, matched on creation | US-05 |
| FR-ENT-3 | Entry | Call and visit outcome capture | US-06, US-12 |
| FR-DUP-1 | Dedup | Property-level supply dedup, second sources, price gaps, sightings | US-07 |
| FR-DUP-2 | Dedup | Demand dedup to touches with first-touch credit | US-08 |
| FR-DUP-3 | Dedup | Review queue, reversible merges | US-09 |
| FR-CLS-1 | Categorisation | Classification in BRD order with side_evidence, needs_review and review_reason; scope routing | US-10 |
| FR-CLS-2 | Categorisation | Generated display labels from stored fields | US-10, US-33 |
| FR-VOC-1 | Vocabulary | Versioned, read-only controlled vocabulary shared with the extractors | US-37 |
| FR-DSK-1 | Desks | Business, Capital, Archive, Network and Watchlist list views, tasks, linked Property | US-36 |
| FR-LIF-1 | Life curve | Engine, thresholds, automatic actions | US-11 |
| FR-SUP-1 | Supply | Must/Should call queues, capacity, ranking, outcomes, attempts | US-12 |
| FR-SUP-2 | Supply | Multiple offers per property, verify, qualify, retire | US-13, US-14, US-18 |
| FR-SUP-3 | Supply | Upcoming offers and lease-renewal auto-creation | US-16 |
| FR-SUP-4 | Supply | Projects, price sheets, configurations, units | US-17 |
| FR-PUB-1 | Publication | Ceiling computation, level choice, auto-downgrade, privacy scan, RERA | US-15 |
| FR-DEM-1 | Demand | Demand queues, first call, qualify, inventory check | US-19, US-20 |
| FR-DEM-2 | Demand | Sourcing requests and anonymous demand posts | US-22 |
| FR-DEM-3 | Demand | Proposals (PDF, share link), site visits | US-23, US-24 |
| FR-DEM-4 | Demand | Deals with mandatory follow-ups; close; cancel | US-25, US-27 |
| FR-DEM-5 | Demand | Exits Lost / Dormant / Invalid with side effects | US-26 |
| FR-MAT-1 | Matching | Many-to-many, bundles, date-aware, flags, propagation, scores | US-28 |
| FR-MAT-2 | Matching | Match notifications and Must call trigger | US-29 |
| FR-DSH-1 | Dashboards | Demand, Supply, Other scopes and Data-quality dashboards (classification grids, side checks) with drill-down | US-30, US-10a |
| FR-CHT-1 | Chat | Grounded Q&A, tables, Excel, "How I got this" | US-31 |
| FR-CHT-2 | Chat | Chat-first UI, cards, panels, My queue, confirm-before-change | US-31, all |
| FR-EXP-1 | Export | Background audited exports | US-32 |
| FR-API-1 | Listings API | Offers, projects, anonymous demand posts at publication level; change feed | US-33 |
| FR-VIS-1 | Access | Tenant isolation, roles, audit of contact views | §2 |
| FR-ADM-1 | Admin | Users, capacities, thresholds, weights, micromarkets, RERA, keys | US-34 |
| FR-AUD-1 | Audit | Immutable audit log | US-35 |
| FR-NTF-1 | Notifications | In-app: uploads done, matches, SRQs, handoffs, closes/exits, overdue follow-ups | US-29, §4.4 |

---

## 8. Non-functional requirements

### 8.1 Defaults from CLAUDE.md (kept)
| ID | Requirement |
|---|---|
| NFR-1 | Throughput: 1,000 requests/second sustained across synchronous APIs (A-30) |
| NFR-2 | Latency: p95 < 300 ms for synchronous APIs (lists, records, queues, Listings API) |
| NFR-3 | Availability: 99.9% monthly |
| NFR-4 | Backups with PITR; encryption at rest and in transit |

### 8.2 Product-specific
| ID | Area | Requirement |
|---|---|---|
| NFR-5 | Bulk | 100k-row file processed in ≤ 30 min, 10 files/day (~1M rows/day) |
| NFR-6 | Async | Uploads, extraction, dedup, matching, life-curve runs, exports, PDFs and photo fetch run off the request path |
| NFR-7 | Chat | First token ≤ 3 s; full answer ≤ 15 s (p95) |
| NFR-8 | Queues and dashboards | My queue ≤ 1 s, dashboards ≤ 2 s (p95) at 5M records |
| NFR-9 | Life curve | Event-driven actions ≤ 5 min; nightly run finishes by 04:00 IST |
| NFR-10 | Freshness to API | Publication changes reach the Listings API ≤ 1 min |
| NFR-11 | Volume | Year 1: ~5M offers and demands, ~20M sightings, ~1M people (A-31) |
| NFR-12 | Residency | All data, backups and AI inference on personal data in India |
| NFR-13 | Privacy | PII marked, never logged, never in API responses; contact views audit-logged |
| NFR-14 | AI privacy | No personal data to third-party AI providers (D-8) |
| NFR-15 | Tenant isolation | Every read and write scoped by organisation, proven by automated tests |
| NFR-16 | Security | Google sign-in (2-step verification required on accounts); 12 h idle session expiry; OWASP ASVS L2 |
| NFR-17 | Recovery | RPO ≤ 5 min, RTO ≤ 1 h |
| NFR-18 | Retention | Personal data purged 24 months after last activity on all linked records (A-34). Market data points kept without personal data |
| NFR-19 | Browsers / a11y | Latest 2 versions of Chrome, Edge, Safari, Firefox; WCAG 2.1 AA on core flows |

### 8.4 Phase 1a pilot on free plans (CR-005)
Until the **paid-plan gate** is passed, these relaxations apply. The gate: Vercel Pro (bom1), Supabase Pro + PITR
(Mumbai), a dedicated Hugging Face endpoint. After the gate, all approved NFRs apply again with no further CR.

| NFR | Approved | Pilot value |
|---|---|---|
| NFR-1 Throughput | 1,000 rps | Best effort (free-plan limits) |
| NFR-3 Availability | 99.9% | Best effort; no SLA |
| NFR-4 Backups | PITR | Nightly `pg_dump` per schema; up to 24 h data loss acceptable |
| NFR-5 Bulk | 100k rows ≤ 30 min, 10 files/day | ≤ 20k rows per file, ≤ 3 files/day (DB ≤ 500 MB) |
| NFR-11 Volume | 5M records | ≤ ~200k records in total |
| NFR-17 RPO/RTO | 5 min / 1 h | 24 h / 1 day |
| Data | Real 11 Estates data | **Sample or anonymised data only**; no real client or owner contacts. Intake has an **anonymise-on-import switch** (pilot only) that replaces names, phones, emails and other contacts with consistent fake values (CR-006 Z-9) |
| Use | Production | **Internal testing and demo only** (Vercel Hobby is non-commercial) |

### 8.3 Listings API fields
- **Anonymous offer:** public ID, **generated label**, deal_type, market, segment, property_type, bhk_min/max, city,
  micromarket, locality, area (built up and/or carpet), price or rent, possession_date, deal tags (sale_mode,
  tenancy_status, furnishing), "subject to confirmation" note, 11 Estates MahaRERA number.
- **Public offer:** everything in Anonymous plus photos, floor band (low / mid / high, A-43), parking, amenities,
  possession_status, sanitised description.
- **Project (Sale, Primary):** name, developer name, locality, configurations (property_type, bhk, price from, units
  available band), possession, amenities, floor plans, photos, project RERA number, 11 Estates MahaRERA number.
- **Anonymous demand post:** "Wants" label, deal_type, segment, property_type, micromarkets, area range, budget band, timing.
- **Never:** building/society name, wing, unit, exact floor, street address, contacts, sources, internal notes, owners,
  side_evidence, needs_review data. Non-property scopes are never served.

---

## 9. External systems
| System | Direction | Purpose | Notes |
|---|---|---|---|
| 11 Estates website and project microsites | They call us | Listings API | API key per site; change feed |
| Image hosts (links in sheets) | We fetch | Photos | Public URLs only; failures listed, never block |
| AI model hosting | We call | Extraction, classification, chat, bundle suggestions | NFR-12/14; self-hosted open-weight likely; Stage 3 |
| Google Identity | Sign in | Staff login | Invited accounts only |
| Email (transactional) | To staff only | Invites, digests | No outbound to clients or owners |
| **Newspaper extractor** and **WhatsApp extractor** (11 Estates, owned by Vinit) | Produce upload files | Standard-schema files (BRD §4.2) uploaded by staff | Strict intake mode (D-15); shared vocabulary (D-16) |
| Next phase (not Phase 1) | — | WhatsApp (n8n), Meta lead ads, website form connectors | D-13, BRD OQ-7 |

---

## 10. Assumptions
Numbering continues. Assumptions A-20 and A-28 from v0.3 are dropped (CR-002 X-8). A-35 is dropped: Land is a segment (CR-003 Y-1).

- **A-14** Data operators work the review queues for all uploads.
- **A-15** One role per user. A Data operator permission can be added to an agent.
- **A-16** First touch gets attribution credit (BRD A-16). Shared-commission terms with an introducing broker are
  recorded as a note and % on the demand. There is no commission calculation (BRD out of scope). Closes BRD OQ-21 unless you object.
- **A-19** Max file 150k rows / 50 MB.
- **A-25** Max export 100k rows; link valid 24 h.
- **A-26** Photos: JPG/PNG/WebP ≤ 10 MB, ≤ 30 per property.
- **A-30** 1,000 rps target kept (CLAUDE.md default); may be lowered to cut cost.
- **A-31** Year-1 volumes as NFR-11.
- **A-32** RPO ≤ 5 min, RTO ≤ 1 h.
- **A-34** Personal data retention 24 months after last activity.
- **A-36** Default daily capacity 40 calls per person, editable by Managers.
- **A-37** 3 unanswered attempts marks a person unreachable (BRD OQ-23 proposal).
- **A-38** Bundles: up to 3 offers, same building or adjacent micromarket, commercial and industrial only.
- **A-39** Price-gap flag when two sources differ by > 5%.
- **A-40** Proposal share links expire after 14 days.
- **A-41** Default Dormant revisit: 60 days (BRD OQ-24).
- **A-42** A new match on a not-yet-Contacted offer puts it in Must call (BRD §5 "Signal").
- **A-43** Public listings show a floor band, not the exact floor, to avoid identifying the unit.

## 11. Open questions
| # | Question | Blocking? |
|---|---|---|
| OQ-4 (BRD) | Sample files for dedup rules: one newspaper ad repeated over 3+ days, and one client in two sources | No (needed before Stage 4) |
| OQ-7 (BRD) | Which connector first next phase? Does Vinit already run an n8n WhatsApp flow that could produce upload files now? | No |
| OQ-11 (BRD) | Budget, launch date, team size | Stage 3 |
| OQ-13 (BRD) | Review the chat benchmark in Appendix A | No |
| OQ-P9 | Confirm A-36 (40 calls/day), A-41 (60-day Dormant revisit), A-40 (14-day proposal links) | No |
| OQ-P11 | Resolved by CR-006: Appendix C = the 89 extractor columns. A sample WhatsApp extractor file is still wanted to confirm sender_name, sender_phone and text_variants | No |
| OQ-P10 | Should the supply team see a client's name on a matched demand, or only the demand summary? (D-1 says all staff see all; confirm this includes client identity) | No |

## 12. Traceability to BRD v0.6
| BRD | Covered by |
|---|---|
| G1 One clean database | US-01…10, FR-ING, FR-ENT, FR-DUP, FR-CLS |
| G2 Automatic understanding | US-10 |
| G3 Matching | US-28, US-29, §4.5 |
| G4 Guided journeys | §4.1–4.4, US-11…27, P-01 |
| G5 Self-serve insight | US-30…32 |
| G6 Distribution | US-15, US-33, §4.6, §8.3 |
| G7 SaaS ready | R-VIS-1, NFR-15 |
| M1–M9 | US-01 (M1, M2), US-07/08 (M3, M4), US-10 (M5), US-21 (M6), US-31 (M7), US-15/33 (M8, M9) |
| R10–R14 | US-03, US-12/D-10, US-08, US-25, US-15/33 |

---

## Appendix A: Chat benchmark (draft, please edit)
1. How many active 2BHK lease offers are there in Andheri West?
2. Show resale 3BHK offers in Powai under ₹3 Cr that are Fresh.
3. Which micromarkets have more open demand than matching supply for commercial lease (deal_type Lease, segment Commercial)?
4. What was the average closed rent for offices in Marol this quarter?
5. List my follow-ups overdue today.
6. Which Public offers turned Stale this week?
7. Show demands in Sourcing for more than 7 days.
8. Which source type gave us the most qualified demand last month?
9. Give me all industrial galas for lease in Bhiwandi as an Excel file.
10. How many offers did each supply agent verify this week?
11. Show bundles suggested for office demand above 5,000 sq ft.
12. Which Upcoming offers become available in the next 60 days?
13. Can you help me match the requirements for an industrial area of 4,000 sq ft? *(from product owner)*

## Appendix B: Acceptance scenarios (from Vinit's journeys artifact)
Each scenario must run end to end in the product, with the stated status axes, queue entries and dashboard effects. See
`docs/inputs/vinit-journeys-artifact.md` for the step-by-step detail.

| ID | Scenario | Key checks |
|---|---|---|
| AS-D1 | DEM-000127 captured via **Channel** (Anil's WhatsApp post) → second touch via Meta lead ad → qualified → 3 matches incl. a Marol **bundle** → proposal → site visit → In process (DEAL-0019) → **Closed**; Anil's share noted | First touch credit stays with Channel; bundle is one match; other matched demands on the closed offer notified |
| AS-D2 | Same, via **Digi** first, **no inventory** → SRQ + anonymous demand post → Add supply ×3 (INV-00611 found leased → match dropped) → proposal → **Lost** (Powai, 2 months rent free) | Sourced-for tags; demand post withdrawn on match; competing terms saved as market data; matches released |
| AS-D3 | Via **Direct** (Mr Shah referral, quick add) → qualified → matched → proposal → client silent → Ageing at day 31 → reconfirm → **Dormant** until 1 Mar | Phone-first quick add; referrer credit; life curve pause; revisit returns to queue |
| AS-D4 | **Invalid** variants: broker posing as client (flag: anonymous shares only); unreachable after 3 attempts; client is actually a broker (moved to People as Broker) | Person flags affect future records |
| AS-S1 | **Interest first**: Sanjay's post → Should call rank 38 → Anonymous → Rakesh duplicate → second source + price gap → enquiry → Must call → confirmed ₹8.5 L + sale offer ₹11 Cr → verified → Public → 3 matches → leased → other demands notified → sale offer "tenant in place" | Two offers on one property; auto-close propagation |
| AS-S2 | **Proactive vetting**: newspaper 2BHK Andheri W → Should call rank 4 (demand gap 12) → confirmed → photos → Public → 2 matches | Photos shared = permission; demand-gap ranking |
| AS-S3 | **Sourced for a demand**: SRQ-014 → Add supply → Contacted, matched on creation, Private by choice → verified → qualified → visit → In process → closed | Top-priority verification; Private allowed while Public ceiling |
| AS-S4 | **Ageing record**: Public offer → day 31 Should call → day 61 Stale → Anonymous → day 91 Expired → unpublished, "Availability unknown" → call: leased at ₹5 L → Inactive + market data | Auto-downgrade and withdrawal via API ≤ 1 min |
| AS-S5 | **Future availability**: Upcoming INV-00701 (from 1 Feb) → Anonymous with date → fintech excluded "Available too late", logistics firm matched → clock starts 2 Dec → verified → Public → visit 1 Feb | Date-aware exclusion; life curve start rule; lease-renewal Upcoming |
| AS-S6 | **New project**: PRJ-0031 with 2 BHK (38 units) and 3 BHK (22) → Public → 11 enquiries, 4 matches (one also matched to resale) → new sheet: price up, units down → "price above budget" flag → Ageing → request sheet → booking reduces units | Project RERA on listings; unit counts; price-change flags |

## Appendix C: Field dictionary (the upload schema, CR-006 Z-1)

This is the exact column set of the extractor master file (91 columns since CR-012; the 89-column set of older extractor versions, i.e. without `building_name` and `floor`, is still accepted). A file whose header matches either set uses **strict mode** (D-15). Column order does not matter. Extra sheets `run_log` (ignored) and `migration_map` (`old_ad_id`, `new_record_ids`, `action`; applied first, Z-5) are recognised. A PII-free profile of real values is in `docs/inputs/extractor-master-profile.md`.

### CRM working columns: ignored on import except route_to (Z-8) and crm_notes (CR-012)
| Column | Type / values |
|---|---|
| `lead_status` | text |
| `follow_up_date` | date |
| `crm_notes` | text; imported as a note on the record, marked "imported from upload <code>" (CR-012). Never sent to AI or published |
| `route_to` | enum: Supply Team, Demand Team, Business Desk, Capital Desk, Archive, Network, Watchlist |

### Review
| Column | Type / values |
|---|---|
| `needs_review` | bool |
| `review_reason` | text (";"-joined); CRM derives a reason code |

### Identity and splits
| Column | Type / values |
|---|---|
| `record_id` | 12-hex id; upsert key |
| `parent_record_id` | 12-hex id of the source ad (split parent) |
| `split_index` | "k of n" |

### Classification (BRD §4.2)
| Column | Type / values |
|---|---|
| `record_scope` | enum (BRD §4.2) |
| `deal_type` | enum, pipe-list (BRD §4.2) |
| `market` | enum: Primary, Secondary, Any; Sale only; blank = unknown |
| `segment` | enum: Residential, Commercial, Industrial, Land |
| `property_type` | enum, pipe-list, per segment |
| `property_detail` | text |
| `building_name` | text, optional (CR-012). Private: property-level dedup and proposals only; never public; redacted before any AI call |
| `floor` | text, optional (CR-012), e.g. "12", "G", "12 of 20". PII-sensitive: never public |
| `land_use` | enum: Residential, Commercial, Industrial, Agricultural, NA, Mixed |
| `side` | enum: Supply, Demand, None |
| `side_evidence` | text |

### Deal tags
| Column | Type / values |
|---|---|
| `sale_mode` | enum: Private, Auction |
| `deadline_date` | date |
| `tenancy_status` | enum: Vacant, Tenanted |
| `tenure` | enum: Freehold, Leasehold |
| `agreement_form` | enum: Leave and License, Registered Lease |
| `is_jodi` | bool |
| `possession_status` | enum: Ready, Under Construction, Under Redevelopment, Available From |
| `possession_date` | YYYY, YYYY-MM or YYYY-MM-DD |
| `furnishing` | enum: Furnished, Semi Furnished, Unfurnished, Bare Shell |

### Non-property
| Column | Type / values |
|---|---|
| `sector` | enum (BRD §4.2) |
| `includes_property` | enum: Yes, No |
| `business_description` | text |
| `participant_role` | enum (BRD §4.2) |
| `signal_type` | enum (BRD §4.2) |

### Project
| Column | Type / values |
|---|---|
| `project_name` | text |
| `developer_name` | text |

### Configuration and features
| Column | Type / values |
|---|---|
| `bhk_min` | number (0.5 = 1 RK) |
| `bhk_max` | number |
| `features` | text |

### Location
| Column | Type / values |
|---|---|
| `locality` | text, normalised to the micromarket hierarchy |
| `city` | text; outside MMR is flagged (Z-7) |
| `state` | text |
| `landmark` | text |
| `location_text` | text (as written) |

### Area
| Column | Type / values |
|---|---|
| `area_sqft_min` | number |
| `area_sqft_max` | number |
| `area_basis` | enum: Carpet, Builtup, Saleable; blank = unknown |
| `land_area_value` | number |
| `land_area_unit` | enum: acre, sqft, sqm, sqyd, gunta, bigha |
| `land_area_sqft` | number |
| `area_text` | text (as written) |

### Price
| Column | Type / values |
|---|---|
| `price_text` | text (as written) |
| `sale_price_inr_min` | integer INR |
| `sale_price_inr_max` | integer INR |
| `sale_rate_inr` | integer INR per unit |
| `sale_rate_unit` | enum: sqft, acre, sqyd, sqm |
| `price_negotiable` | bool |
| `rent_monthly_inr_min` | integer INR |
| `rent_monthly_inr_max` | integer INR |
| `rent_rate_psf` | number INR per sq ft |
| `deposit_inr` | integer INR |
| `deposit_months` | integer |
| `current_rent_inr` | integer INR (tenanted sale) |
| `yield_pct` | number |

### Contact (PII: anonymised in the pilot)
| Column | Type / values |
|---|---|
| `contact_name` | text, PII |
| `company_name` | text |
| `party_type` | enum: Owner, Broker, Developer, Company, Bank, Society, Government |
| `phones` | E.164, "\|"-list, PII |
| `whatsapp_phone` | E.164, PII |
| `emails` | "\|"-list, PII |
| `rera_number` | text |
| `other_contact` | text, PII |

### Source
| Column | Type / values |
|---|---|
| `source_channel` | enum: Newspaper, WhatsApp (maps to source type Channel) |
| `source_name` | text (publication or group) |
| `source_edition` | text |
| `source_supplement` | text |
| `source_date` | date |
| `source_page` | integer |
| `source_files` | text |

### Repeats
| Column | Type / values |
|---|---|
| `first_seen_date` | date |
| `last_seen_date` | date |
| `times_seen` | integer |
| `possible_repeat_of` | 12-hex id → uncertain-merge review item |

### Extraction
| Column | Type / values |
|---|---|
| `raw_text` | text, PII (redacted before any AI use) |
| `source_language` | text |
| `ocr_used` | bool |
| `extraction_confidence` | number 0–1 |
| `extractor_notes` | text |

### WhatsApp extractor
| Column | Type / values |
|---|---|
| `sender_name` | text, PII (WhatsApp) |
| `sender_phone` | E.164, PII (WhatsApp) |
| `text_variants` | text (WhatsApp repeats) |
