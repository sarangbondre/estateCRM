# 01 — Business Requirements Document (BRD)

| | |
|---|---|
| Project | estateCRM |
| Version | 0.5 |
| Date | 2026-09-23 |
| Author | Sarang Bondre (product owner), drafted with Claude; v0.4 and v0.5 revised by Vinit with Claude from the 11 Estates operating system sessions |
| Status | PROPOSED via CR-002 (source: `docs/inputs/CRM-01-brd-v0.5.pdf`) |

### Change log
| Version | Change |
|---|---|
| 0.1 | Initial draft |
| 0.2 | Answered OQ-1 (internal first, SaaS later), OQ-2 (India, Mumbai first), OQ-3 (volume), OQ-4 (dedup is a hard problem to design), OQ-5 (Lead deferred), OQ-8 (Listings API scope). Scope, metrics, constraints and risks updated to match. |
| 0.3 | Company name recorded as "11estate" (OQ-18). Corrected in 0.4. |
| 0.4 | Company name corrected to **11 Estates**. Document restructured around the demand and supply journeys. New sections: data model (4), status model, life curve and publication rules (4), supply journey (5), demand journey (6), matching rules (7) and dashboards (8). Brought into scope: deal stages up to Closed, Enquiry, single record entry, publication levels, project microsites and anonymous demand posts. OQ-12, OQ-14, OQ-15, OQ-16 and OQ-17 answered. File upload remains the only ingestion channel. Stack and success metrics unchanged from 0.3. |
| 0.5 | A-2 confirmed: Phase 1 needs both file upload and manual entry and updates in the app. A-17 confirmed: lead and enquiry exports are uploaded daily. Connectors confirmed for the next phase; OQ-7 reworded to match. |

---

## 1. Problem Statement

Real estate market data reaches brokers through many unrelated channels: newspaper classifieds, WhatsApp groups,
property websites, enquiry forms, Instagram and Facebook posts, builder price sheets in Excel, and databases shared
between brokers. Each source uses its own layout, column names, spelling and level of completeness.

Today this data is:
- **Scattered** across files and chats, so nobody has a single view of what is available (supply) and what is wanted (demand).
- **Duplicated.** The same ad runs for days and in more than one newspaper. The same property appears in more than one
  broker sheet. The same client reaches the firm through a broker, an ad and a referral. This inflates volume, wastes
  follow up effort and creates commission disputes.
- **Unstructured.** Free text such as "2BHK Andheri W 1.2Cr negotiable, call 98xxxxxx" must be read by a person to be understood.
- **Unverified and ageing.** Most records are never checked with the source, and nobody tracks when a property was last
  confirmed as available. Listings stay up long after the property is sold or rented, and old requirements stay open
  after the client has moved on.
- **Manually matched.** Pairing a requirement with a property depends on a broker's memory, so good matches are missed.
  When nothing matches, the search for new supply on portals and through the network happens outside any system.
- **Without a working process.** There is no shared rule for when to call an owner, when to publish, when to follow up a
  client or when to let a requirement go. Deals stall between site visit and closing because nobody owns the follow up.
- **Hard to query or publish.** Answering "how many 3BHK rentals under ₹1L in Bandra?" or publishing inventory to the
  company website needs manual spreadsheet work.

## 2. Business Context and Users

Phase 1 is an internal tool for 11 Estates, run by two teams: a **demand team** that works buyers and tenants, and a
**supply team** that works owners, brokers and developers. Later, the same product is sold as SaaS to other brokers,
where each customer (tenant) sees only its own data.

| User | Who they are | What they need from the system |
|---|---|---|
| Demand team | 11 Estates staff who work buyers and tenants from first contact to closing | A queue of demand to contact, qualify, reconfirm and follow up; matched supply; proposals, site visits and In process deals in one place; a way to request supply when nothing matches |
| Supply team | 11 Estates staff who work owners, brokers and developers | A call queue ranked by priority and daily capacity; tools to verify, publish and reconfirm offers; incoming sourcing requests from the demand team |
| Owner / manager | Runs the business | Demand and supply dashboards: queues, life curve health, exits, conversion and source quality |
| Data operator | Staff who collect and upload files (may sit in either team) | Upload any sheet in any template quickly; see what was accepted, rejected and duplicated |
| Listing consumer (system) | The 11 Estates website and project microsites | A stable API returning what may be published, at the right publication level |
| (Future) Tenant admin | Admin at a broker firm that buys the SaaS | Manage their own users and data, isolated from other tenants |

## 3. Business Goals

- **G1: One clean database.** Every record lands in one place in a common structure (Properties, Projects, Offers,
  Demand, People and Enquiries), with duplicates and reposts identified across supply, demand and people.
- **G2: Automatic understanding.** Every record is classified as Supply or Demand, by segment and transaction type, and
  demand by source type, without manual tagging.
- **G3: Automatic matching (core value).** The system continuously pairs demand with supply, many to many, respecting
  location, area, price and availability dates, and ranks the matches.
- **G4: Guided journeys.** Every offer and every demand moves through defined stages. Queues tell each team what to do
  next, and a life curve retires records nobody has confirmed.
- **G5: Self serve insight.** Demand and supply dashboards, plus natural language chat over the data that answers
  questions, shows tables and produces Excel downloads.
- **G6: Distribution.** Publishable supply, project microsites and anonymous demand posts are served through a listings
  API, within the publication rules.
- **G7: SaaS ready.** Built for one company now, in a way that lets the product be sold to other brokers later with
  strict data separation and no re-architecture.

## 4. Data Model and Record Rules (business view)

### 4.1 Core records
| Record | ID | What it is |
|---|---|---|
| Property | PRP | A physical asset: flat, office, shop, warehouse or plot. Holds location, building, areas and photos. |
| Project | PRJ | A new development. Holds developer, RERA registration and its configurations. |
| Offer | INV | Something on offer: a lease or a sale on a Property, or one configuration in a Project with a unit count. Status, price, availability, life curve and matches live on the Offer. One Property can carry a lease offer and a sale offer at the same time; 120 flats in a project become a handful of configuration offers. |
| Demand | DEM | A requirement from a buyer or tenant. |
| Person | | A person or phone number with one or more roles: owner, broker, client, referrer, developer. One person links to many offers and demands and can be on both sides at once, for example selling one flat to buy another, with the dependency recorded. |
| Enquiry | ENQ | A response from the market found in an uploaded export (lead form, website or microsite form, listing enquiry), tied to the offer, campaign or project that produced it. Replaces the deferred Lead for Phase 1 needs. |
| Touch | | One appearance of a demand through a source. A demand can have many touches; the first touch gets the credit. |
| Match | MAT | A ranked pairing of a Demand with one Offer or a bundle of Offers. |
| Sourcing request | SRQ | A request from the demand team to the supply team to find supply for a demand that has no match. |
| Proposal | PROP | The options shared with a client against a demand. |
| Site visit | | A visit by a client to an offer. |
| Deal | DEAL | Tracks one demand and one offer from agreed terms through In process to Closed or cancelled. |
| Raw record / sighting | | A row exactly as uploaded; one raw appearance of a record. Every clean record traces back to its sightings. |
| Market data point | | A closed or reported price kept as intelligence, including properties that closed elsewhere. |

### 4.2 Segments and transaction types
Segments are Residential, Commercial and Industrial, with Land and Plots pending OQ-6. Supply and demand share the same
grid of segment and transaction type, so matching is symmetric. Labels follow the side of the market.

| Transaction type | Supply label | Demand label |
|---|---|---|
| Resale (sale of an existing property) | Resale, for sale | Resale, to buy |
| Lease / Rent | Lease, for rent | Lease, to rent |
| New project (primary sale by a developer) | New project | New project |

### 4.3 Source types
Every demand, and every offer, carries a source type. In Phase 1 records enter by file upload or manual entry;
connectors come in the next phase.

| Source type | Where it comes from | How it enters in Phase 1 |
|---|---|---|
| Channel | Newspaper classifieds, WhatsApp groups, property portals | Uploaded files (newspaper data sheets, exported WhatsApp chats or sheets built from them); captured and classified automatically. Portal finds typed in during sourcing are Channel, typed in. |
| Digi | Instagram and Meta posts and ads, microsites, website enquiry forms, enquiries on 11 Estates listings | Uploaded exports of lead forms and enquiry logs, each row carrying the campaign, form, project or listing ID; captured automatically |
| Direct | References, direct calls, messages and walk ins to the team | Typed in by the team through quick add |

Source type and capture mode are stored separately (for example "Channel, typed in"). When one demand arrives through
more than one source, each arrival is stored as a touch and reporting credits the first touch.

### 4.4 Status model
Each record has independent status axes, so an offer can be unverified and still published anonymously, or matched
while its record is only Captured.

| Supply offer axis | Stages | Meaning |
|---|---|---|
| Record | Captured, Enriched, Contacted, Verified, Qualified | What the team knows. Enriched covers automatic and desk work. Contacted means a person spoke to the source. Verified means real photos and details are confirmed. Qualified means terms are agreed with the source. |
| Publication | Private, Anonymous, Public | What the market can see, capped by the rules in 4.6. |
| Commercial | Upcoming, Available, Matched, In proposal, Site visit, In process, Closed, Inactive | Deal progress. Upcoming means the Available from date is in the future. Inactive means gone, sold or leased elsewhere, or the source is unwilling. |
| Signals | Enquiries, matches, sightings | Market interest. Signals raise call priority. They are counters on the record, separate from its stages. |

| Demand axis | Stages | Meaning |
|---|---|---|
| Record | Captured, Enriched, Verified, Qualified | What the team knows about the requirement and the client. |
| Publication | Private, Anonymous | Anonymous demand posts are used during sourcing. |
| Commercial | New, Contacted, Active, Sourcing, Matched, Proposal shared, Site visit, In process, Closed | Sourcing is skipped when the CRM already holds a match. In process covers negotiation, contract work and registration. |
| Exits | Lost, Dormant, Invalid | Lost records the reason and any competing terms. Dormant records a revisit date and pauses the life curve. Invalid records the reason and flags the person. |

Matches and deals can move backwards. When a token is refunded, a loan is rejected or a landlord withdraws, the offer
returns to Available, the demand returns to Active, and the failed deal stays on record.

### 4.5 Life curve
Every live offer and every live demand counts the days since it was last confirmed on a call, meeting or visit. Any
confirmation resets the count to day 0. Reposts and new sightings update **last seen** and leave **last confirmed**
unchanged. For new projects the count follows the date of the developer's latest price sheet. For offers with a future
Available from date, the count starts 60 days before that date.

| Supply offer category | Fresh | Ageing | Stale | Expired |
|---|---|---|---|---|
| Residential Lease | to 14 days | to 30 | to 45 | after 45 |
| Commercial Lease | to 30 days | to 60 | to 90 | after 90 |
| Resale | to 45 days | to 90 | to 120 | after 120 |
| New project | to 30 days | to 60 | to 90 | after 90 |
| Industrial | OQ-19 | | | |

| Demand category | Fresh | Ageing | Stale | Expired |
|---|---|---|---|---|
| Residential Lease | to 14 days | to 21 | to 30 | after 30 |
| Commercial Lease | to 30 days | to 60 | to 90 | after 90 |
| Resale (to buy) | to 45 days | to 90 | to 150 | after 150 |
| New project | to 30 days | to 60 | to 120 | after 120 |
| Industrial | OQ-19 | | | |

| Stage | Rule for a supply offer | Rule for a demand |
|---|---|---|
| Fresh | All publication levels allowed | No action |
| Ageing | Added to Should call for reconfirmation | Reconfirm call added to the demand team's queue |
| Stale | Public drops to Anonymous automatically; moves up Should call | New match suggestions stop until the client reconfirms |
| Expired | Unpublished everywhere, including anonymous listings; left out of automatic matching until reconfirmed | Moves to Dormant automatically |

*Thresholds are initial values for confirmation (OQ-19).*

### 4.6 Publication rules
- **Private** is always allowed.
- **Anonymous** is allowed while an offer is Fresh or Ageing, including before anyone has spoken to the source. It shows
  locality, area, price and availability, with a note that details are subject to confirmation.
- **Public** is allowed only when the offer is Verified with real photos and is Fresh or Ageing. Photos shared by the
  source count as permission; there is no separate consent step. If in doubt, the team keeps the offer Anonymous.
- The rules set a ceiling. The team decides where to publish within it.
- No publication level exposes contact details or the exact address (building or society name, wing, flat number or
  street), including details hidden in free text or photos. Building names go only into proposals for qualified clients.
- Every listing shows the 11 Estates MahaRERA agent registration number. Project listings and microsites also show the
  project's RERA registration number.
- Closed, Inactive and Expired offers are unpublished automatically. Upcoming offers may be published with their
  Available from date.

## 5. Supply Journey

The supply team owns every offer from capture until it is matched. From the match onward, the demand team runs the
client side while the supply team keeps the source informed and sees progress on the offer.

| Stage | What happens | Owner |
|---|---|---|
| Capture | A row is uploaded and kept raw. Attributes are extracted. The duplicate check works at property level (building, floor, area, locality), never on phone number alone. It creates a Property and Offer, or links the row to an existing one as a sighting or a second source with any price gap flagged. | System |
| Queue | The offer enters Should call with a rank. | System |
| Publish anonymously | Optional, when the team has not yet spoken to the source. | Supply team |
| Signal | An enquiry or a match moves the offer to Must call. | System |
| Contact | The call confirms availability, price and areas and resets the life curve. Further offers on the same property (for example a sale alongside a lease) are added here. | Supply team |
| Verify | Real photos and details collected. Public unlocks. | Supply team |
| Qualify | Terms agreed with the source, including revenue share with a partner broker. The broker's own record is qualified. | Supply team |
| Match and hand off | Matched demands go to the demand team for proposal, site visit and In process. | Both |
| Close or retire | Closed: unpublished, other matched demands notified, closing price kept as market data. Inactive: kept for intelligence. | Both |

### 5.1 Situations the journey must handle
| Situation | How it runs |
|---|---|
| Interest first | No spare bandwidth. The offer waits anonymously until an enquiry or match moves it to Must call, then is contacted, verified and published Public. |
| Proactive vetting | Bandwidth is available, so the team calls before any interest, verifies and publishes Public directly. |
| Sourced for a demand | Created from a demand or sourcing request, starting at Contacted, tagged Sourced for DEM, matched on creation and verified at top priority. May stay Private while the client decides. |
| Ageing record | Nobody reconfirms. The life curve moves it through Ageing (reconfirm), Stale (downgraded to Anonymous) and Expired (unpublished). A reconfirm call resets it or retires it to Inactive. |
| Future availability | Created as Upcoming with an Available from date; published with that date; matched only to demand whose timing fits; the life curve starts 60 days before the date. Closing an 11 month lease creates an Upcoming offer for the same property at month 10. |
| New project | A Project with configuration offers and unit counts, built from the developer's price sheet. Price revisions update offers and flag matches that go over budget. A booking reduces the unit count while the offer stays live. |
| Duplicate post | Another broker posts the same property. It is linked as a second source on the existing offer, with the price gap flagged. |

### 5.2 Call queues and bandwidth
- **Must call** holds offers with an enquiry or a match. Target: contact within 24 hours of the enquiry being uploaded.
- **Should call** holds proactive vetting and reconfirmation, ranked by freshness, demand gaps (categories where open
  demand exceeds matching supply), source quality and price band.
- The team sets a daily call capacity. The day's list fills with Must call first and tops up from Should call.
- Every call records an outcome: confirmed; no answer (retry up to 3 attempts); already gone (Inactive, price kept as
  market data); unwilling to work with 11 Estates (kept for matching intelligence, never published).

## 6. Demand Journey

| Stage | What happens | Owner |
|---|---|---|
| Capture | Channel and Digi demand is created from uploaded rows. Direct demand is typed in through quick add, which looks up the phone number first. | System / demand team |
| Deduplicate | The same phone number, company or requirement arriving through another source is merged as a touch on the existing demand. The first touch keeps the credit. Uncertain cases go to review. | System |
| Understand | First call: requirement, budget, timing, locations, decision maker. Resets the life curve. | Demand team |
| Qualify | Decision maker reached, budget and timing confirmed, agreement to work with 11 Estates. | Demand team |
| Check inventory | Decision point: does anything in inventory match? Yes leads to Match. No leads to Sourcing. | System |
| Match | The team confirms suggested matches, including bundles. | Demand team |
| Sourcing | A sourcing request goes to the supply team and the demand is posted anonymously. Supply found on portals or through the network is added through **Add supply** on the demand, prefilled from it and matched on creation, then verified at top priority. The post comes down once matched. | Both teams |
| Proposal shared | Options with photos, built up and carpet area, price, availability and building names. | Demand team |
| Site visit | Client visits; the visit resets both life curves. | Demand team, supply team |
| In process | Negotiation, contract work, stamp duty and registration. Every In process deal carries a next action and a follow up date; overdue deals rise to the top of the demand team's queue. | Demand team |
| Closed | Deal recorded. Other options go back into the pool. Other demands matched to the closed offer are notified and return to matching. | Demand team |

### 6.1 Exits
| Exit | When | What the system does |
|---|---|---|
| Lost | The client closes elsewhere or withdraws, at any stage | Records reason and competing terms as market data; releases all matches |
| Dormant | The client postpones, or the demand life curve expires | Records a revisit date; pauses the life curve; releases matches; returns the demand to the queue on the revisit date |
| Invalid | Fake or unreachable details, or a broker posing as a client | Records the reason; flags the person so future records from them are marked; drops out of all queues |

### 6.2 Handoffs between the teams
- Sourcing request from demand team to supply team, with due date and priority.
- Match notification to the demand team when an offer matches an open demand.
- Proposal, visit and In process status visible on the matched offer for the supply team.
- Automatic notice to every other matched demand when an offer closes, and to matched offers when a demand exits.

## 7. Matching Rules (business level)
- Compares segment and transaction type; micromarket, using a Mumbai locality hierarchy (for example Andheri East
  containing Chakala, Marol, MIDC); area, with built up and carpet stored separately and compared like with like; price
  or budget normalised to one unit; and the offer's Available from date against the demand's move in timing.
- **Many to many.** One offer can hold many demands and one demand many offers. Each pairing is its own match record.
- **Bundles.** Two or more offers can be matched together when only their combined area meets the requirement.
- **Date aware.** Offers available later than the demand's window are excluded with the reason recorded.
- Expired offers are excluded. Stale offers are shown with a reconfirm flag.
- When an offer closes, its other matches close with the reason "Leased to another client" or "Sold to another client",
  and those demands return to matching.
- When a price changes, matches where the new price exceeds the budget are flagged for review.
- Matches are suggestions. The team confirms them, and nobody is contacted automatically. Weights are set in Stage 2
  using broker feedback (M6).

## 8. Dashboards (business view)
Each dashboard tile opens the underlying list. Chat (Section 9, Module B) answers questions beyond the tiles.

| Demand dashboard | Contents |
|---|---|
| Demand by source | Channel, Digi and Direct counts; duplicates merged this week |
| Demand life curve | Fresh, Ageing, Stale and Expired counts |
| Demand team queues | To contact, To qualify, Reconfirm due, In sourcing, Sourcing requests open, Open matches, Proposals out, Site visits this week, In process with follow up due, Deals this month |
| Exits | Lost, Dormant and Invalid this month, with reasons |
| Demand by category | Segment by transaction type grid |

| Supply dashboard | Contents |
|---|---|
| Stock | Properties, Projects and Offers counts; duplicate posts linked this week |
| Supply life curve | Fresh, Ageing, Stale and Expired counts |
| Supply team queues and listings | Must call, Should call, Upcoming offers, share of offers verified, listed Public, listed Anonymous |
| Supply by category | Offers by segment and transaction type grid |

| Data quality dashboard | Contents |
|---|---|
| Uploads | Files and rows per source, accepted, rejected with reasons, duplicates found, time since last upload per source |
| Review queues | Unclassified records, uncertain merges, flagged price gaps |
| Source quality | Share of records per source that verify, match and close |

## 9. Solution Overview: Modules (Phase 1)

### Module A: Ingestion and record entry
- Upload Excel/CSV files from any source, including exported WhatsApp chats, lead form exports and enquiry logs. A single
  file can have about 100,000 rows, with up to 10 uploads per day.
- Files arrive in many templates. The system maps each file to a common structure and remembers mappings for templates
  it has seen before.
- Raw data is always kept exactly as uploaded, with source, uploader and date, so every clean record traces back to its
  original rows.
- Processing runs in the background with a progress view and a per file report (rows accepted, rejected with reasons,
  duplicates found).
- Single record entry and editing in the app: quick add for Direct demand (phone lookup first), Add supply from a demand
  or sourcing request, and updates after calls and visits (outcome, availability, price, photos).
- Photo attachment to Properties and Offers.

### Deduplication (Modules A and B)
- A phone number identifies a Person. It never identifies an Offer or a Demand on its own; one broker's number can
  advertise many properties.
- Reposts of the same ad are one record seen many times. Repeat sightings update "last seen".
- Supply dedup works at property level, and extra sources on the same property are linked as second sources.
- Demand dedup matches phone number, company and requirement across sources and merges arrivals as touches.
- Outcome rules: raw kept in full; each real property, offer, requirement and person appears once, linked to its
  sightings; uncertain cases go to human review and are never merged silently; every merge can be undone.
- Exact matching rules are worked out in Stage 2/3 from sample files (OQ-4).

### Module B: Intelligence and journeys
- **Categorisation** into Supply or Demand, segment, transaction type and source type, with attributes pulled from text
  (locality, building, configuration, areas, price or budget, availability). Low confidence records go to a review queue.
- **Matching engine** following Section 7.
- **Journeys and queues** following Sections 4 to 6: status axes, life curve engine, Must call and Should call, demand
  queues, sourcing requests, proposals, site visits, In process follow ups and exits.
- **Dashboards** following Section 8.
- **Chat interface.** Plain language questions answered with text, tables or an Excel file. Model and hosting decided in Stage 3.

### Module C: Listings API
- Serves Residential, Commercial and Industrial offers to the 11 Estates website and project microsites, at their
  publication level (Anonymous or Public), plus anonymous demand posts.
- Exposed: photos (Public only), price, configuration, area, locality, segment, transaction type, Available from date,
  amenities, floor, furnishing, possession status, and the RERA numbers in 4.6. Exact field list set in Stage 2.
- Never exposed: exact address or contact details, including phone numbers or addresses hidden in free text or photos.
- Listings are withdrawn automatically when offers close, retire or expire, and downgraded when they turn Stale.

### Delivery approach
User interface first (screens and flows) in Stage 2 (PRD). The backend roadmap and implementation plan follow in Stages 3 to 5.

## 10. Success Metrics (unchanged from 0.3; please confirm or change)

| # | Metric | Proposed target | Measured how |
|---|---|---|---|
| M1 | Upload success: share of uploaded rows parsed into the common structure without manual fixing | ≥ 90% | Ingestion report per file |
| M2 | Time from upload to categorised and searchable, for a 100,000 row file | ≤ 30 min | System timestamps |
| M3 | Dedup precision: share of auto merged records that really are the same listing | ≥ 95% | Monthly manual sample of 200 merges |
| M4 | Repost recall: share of repeated newspaper ads correctly linked to the existing listing | ≥ 85% | Manual sample from a known newspaper batch |
| M5 | Categorisation accuracy (Supply / Demand + segment) | ≥ 90% | Manual sample review |
| M6 | Match usefulness: share of top 5 matches a broker rates "relevant" | ≥ 60% | In app feedback on matches |
| M7 | Chat answer correctness on a fixed benchmark of business questions | ≥ 85% | Benchmark set run at each release |
| M8 | Privacy: listings served by the API that contain contact details or an exact address | 0 | Automated scan of API output plus audit sample |
| M9 | Listings API live on 11 Estates website(s) | ≥ 1 site | Integration count |

## 11. Scope

### In scope (Phase 1)
1. Upload of Excel (.xlsx/.xls) and CSV files in any template from any listed source, including WhatsApp chat exports,
   lead form exports and enquiry logs; about 100k rows per file, up to 10 files per day.
2. Template and column mapping with reusable saved mappings.
3. Preservation of raw uploads and row level lineage.
4. Manual entry and editing in the app: quick add, Add supply, and updates after calls and visits.
5. Deduplication of properties, offers, demand and people, including repost detection and demand touches, with a review
   queue and reversible merges.
6. Data model with Property, Project, Offer, Demand, Person roles, Enquiry, Touch, Match, Sourcing request, Proposal,
   Site visit and Deal.
7. Categorisation into Supply or Demand, segment, transaction type and source type; extraction of attributes from free text.
8. Status model, life curve engine and call queues for both teams.
9. Supply and demand journeys through Closed, with exits and In process follow up tracking.
10. Automatic many to many matching with ranking, bundles and date awareness.
11. Demand, supply and data quality dashboards.
12. Natural language chat over the data, with answers, tables and Excel download.
13. Listings API (read only) for the 11 Estates website and project microsites, with publication levels, photos and
    anonymous demand posts, excluding exact address and contacts.
14. Photo attachment for Properties and Offers.
15. City and locality reference data for Mumbai (MMR) with a micromarket hierarchy, designed so more Indian cities can be added.
16. Tenant aware data model from day one.
17. User interface design for all of the above (Stage 2).

### Out of scope (Phase 1)
- Automated scraping or direct connectors to WhatsApp, Facebook, Instagram, newspapers, portals or website forms.
  Connectors are planned for the next phase; in Phase 1 records enter only by file upload or manual entry.
- Outbound communication from the system (SMS, WhatsApp, email). Proposals and demand posts shared in WhatsApp groups
  are sent by staff outside the system and logged.
- Commissions, invoicing, collections and accounting. Deals are tracked up to Closed.
- Document management and electronic signature.
- Building the website and microsites themselves (only the API that feeds them).
- SaaS commercial features: self sign up, tenant onboarding, billing, plans, tenant admin console. The data model is ready for them.
- Native mobile apps.
- Loading cities outside Mumbai/MMR.
- New project steps set aside for a later phase: registering clients with developers, developer empanelment, and
  booking to payout stages after Closed.

## 12. Constraints

| Area | Constraint |
|---|---|
| Region | India only. Launch city Mumbai (MMR); more Indian cities later. INR (lakh/crore), sq ft (carpet and built up), BHK. |
| Compliance | Data includes personal names and phone numbers from third party sources, so the DPDP Act 2023 applies. Data stored in India (A-10). Listings show the 11 Estates MahaRERA agent registration number, and project listings and microsites show the project RERA registration number. |
| Freshness | With no connectors, enquiries reach the CRM only when exports are uploaded. The 24 hour Must call target counts from upload, so lead and enquiry exports need uploading at least daily (A-17). |
| Scale | About 100k rows per file, up to 10 files per day. Bulk and background processing required. |
| Tenancy | Single tenant in Phase 1. Architecture must allow strict multi tenant isolation later without re-architecture. |
| Architecture | Event driven microservices and the stage gated process in CLAUDE.md. |
| AI / model hosting | Open to Hugging Face and other open weight models. Decision in Stage 3. Inference cost at 100k row volumes is a real constraint. |
| Budget / timeline / team | Not yet specified (OQ-11). |

## 13. Key Risks

| # | Risk | Why it matters | Early mitigation idea |
|---|---|---|---|
| R1 | Personal data compliance. Names and phone numbers collected from WhatsApp groups, newspapers and shared broker databases without the individuals' consent. | DPDP penalties, reputation; worse once sold as SaaS | Confirm lawful basis; PII controls and access logging; never expose contacts via API; retention limits |
| R2 | Template variety. Unpredictable layouts break parsing. | Low M1, manual work | Saved mappings, AI assisted column detection, review queue |
| R3 | Free text quality. Abbreviations ("2bhk", "1.2 Cr", "85L"), Hindi/Marathi transliteration, inconsistent locality names ("Andheri W", "Andheri West", "Andheri (W)"). | Poor categorisation, dedup and matching | Mumbai locality dictionary and micromarket hierarchy; unit normalisation; confidence scores; review queue |
| R4 | Wrong dedup merges. Two different flats from the same broker marked as one, or two different clients merged as one demand. | Data loss, trust, wrong attribution | Phone number never the sole key; raw never destroyed; reversible merges; review thresholds |
| R5 | Chat hallucination. Wrong answers stated confidently. | Bad decisions | Answers grounded in real query results; show the data behind each answer |
| R6 | Stale supply and demand. Properties already sold or rented still listed; clients who moved on still chased. | Bad matches, bad listings, wasted calls | Life curve with category thresholds; automatic downgrade and unpublish; reconfirm queues; sightings as last seen |
| R7 | AI inference cost at about 100k rows per file, up to 10 files per day. | Budget | Rules and normalisation first; AI only for rows rules cannot handle |
| R8 | Privacy leak through listings. Phone numbers or building names inside free text or photos (for example a watermark). | Breaks the no contact, no exact address rule | Automatic sanitising before publishing; publication ceiling rules; team choice within the ceiling |
| R9 | Future tenant data leak once sold as SaaS. | Critical trust and legal risk | Tenant ID on every record from day one; isolation enforced in every service |
| R10 | Upload lag. Enquiries sit in exports until someone uploads them. | Slow response loses clients | Daily upload routine; time since last upload per source on the data quality dashboard; connectors in the next phase (OQ-7) |
| R11 | Team bandwidth. Should call grows faster than the team can call. | Share of verified inventory falls; more stale listings | Daily call capacity; ranking by demand gaps; life curve retires records automatically |
| R12 | Attribution disputes. The same client through a broker, an ad and a referral. | Commission disputes, broker trust | Demand dedup with touches; first touch rule (OQ-21); visible, reversible merges |
| R13 | Follow up gaps after site visits. | Deals stall or are lost | In process stage with mandatory next action and follow up date; overdue queue |
| R14 | RERA non compliance on listings and microsites. | Penalties | RERA fields mandatory before publishing |

## 14. Assumptions

Any assumption you reject becomes a correction before approval.

| # | Assumption |
|---|---|
| A-1 | Currency is INR (lakh/crore notation). Units are sq ft (carpet and built up), BHK and acres. |
| A-2 | **Confirmed.** Phase 1 has two ways in, both needed now: file upload (WhatsApp, newspaper, lead form and enquiry data arrives inside uploaded files) and manual entry and updates in the app (quick add, Add supply, updates after calls and visits). Connectors come in the next phase. |
| A-3 | Phase 1 users are 11 Estates staff in a demand team and a supply team, plus management. No public sign up. |
| A-4 | The Listings API is read only and consumed only by the 11 Estates website and project microsites. |
| A-5 | Matching produces suggestions. It does not contact anyone automatically. |
| A-6 | Raw data is kept unchanged. The clean view is separate and linked to raw rows. Whether dedup runs during upload or as a separate step is decided in Stage 3. |
| A-7 | Data is mostly English, with some Hindi/Marathi transliteration. |
| A-8 | Segments are Residential, Commercial and Industrial. Transaction types are Resale, Lease/Rent and New project. Land/plots are handled as sub types (OQ-6). |
| A-9 | The user interface is a web application, desktop first. |
| A-10 | All data is stored and processed in India (Indian cloud region). |
| A-11 | Public listings show locality, area, price, availability and real photos. They never show the building or society name, wing, flat number or street address. Building names are shared only in proposals to qualified clients. |
| A-12 | Up to 10 files of about 100k rows per day, so up to about 1M rows per day at peak. |
| A-13 | Rows that cannot be classified as Supply or Demand go to a review queue. They are not deleted. |
| A-14 | Photos shared by a source count as permission to publish them. There is no consent step. |
| A-15 | Life curve thresholds in 4.5 are initial values. |
| A-16 | The first touch of a demand receives the attribution credit. |
| A-17 | **Confirmed.** Lead and enquiry exports are uploaded at least once a day. |

## 15. Open Questions

None of these block approval of Stage 1. They will be settled in Stage 2 (PRD) unless noted.

| # | Question | Needed by |
|---|---|---|
| OQ-4 | Dedup rules. Please share 2 or 3 anonymised sample files, including one with a newspaper ad repeated over 3 or more days and one with the same client in two sources. | Stage 2 |
| OQ-6 | Should Land/Plots be a separate segment? | Stage 2 |
| OQ-7 | Connectors are planned for the next phase. Which source should get a direct connector first (WhatsApp Business API, website forms, Meta lead ads)? | Next phase planning |
| OQ-9 | AI models: open weight (Hugging Face, self hosted or Inference Endpoints) or hosted APIs? Can personal data be sent to a third party AI provider? | Stage 3 |
| OQ-10 | User roles: do both teams see all data, or does each team see only its side plus matched records? | Stage 2 |
| OQ-11 | Budget, target launch date, team size. | Stage 3 |
| OQ-12 | Matching weights, and whether the team is notified in app when a new match appears. | Stage 2 |
| OQ-13 | Please share about 10 real example questions. They become the M7 benchmark. | Stage 2 |
| OQ-19 | Confirm life curve thresholds by category for supply and demand, and set them for Industrial. | Stage 2 |
| OQ-20 | Daily call capacity for the supply team and the demand team. | Stage 2 |
| OQ-21 | Confirm the first touch rule, and how commission is shared when a broker introduced the client. | Stage 2 |
| OQ-22 | Proposal format: in app view, PDF or Excel export? | Stage 2 |
| OQ-23 | Number of call attempts before a source or client is marked unreachable (proposed 3). | Stage 2 |
| OQ-24 | Default revisit period for Dormant demand. | Stage 2 |

### Answered in 0.4
| # | Answer |
|---|---|
| OQ-12 (part) | Matching compares segment, transaction type, micromarket, normalised area, price or budget, and availability date against move in timing (Section 7). |
| OQ-14 | Records expire through the life curve by category, for both supply and demand (4.5). |
| OQ-15 | Photos are collected on calls and visits or shared by the source, and attached to the Property and Offer. |
| OQ-16 | Anonymous publishing is allowed while fresh; Public only once Verified with real photos; the team chooses within that ceiling (4.6). |
| OQ-17 | Only the locality appears on the website. Building names go only into proposals to qualified clients (A-11). |

## 16. Glossary

| Term | Meaning |
|---|---|
| Supply | A property available for sale, rent or lease |
| Demand | A requirement from someone who wants to buy or rent |
| Property | A physical asset; can carry more than one Offer |
| Project | A new development with configurations and unit counts |
| Offer | A lease or sale on a Property, or one configuration in a Project; where status, price and matches live |
| Listing | An Offer or demand post as published through the API |
| Enquiry | A market response found in an uploaded export, tied to the offer, campaign or project behind it |
| Lead | (Deferred) A prospect workflow; Phase 1 needs are met by Enquiry |
| Source type | Channel, Digi or Direct |
| Touch | One arrival of a demand through a source |
| Segment | Residential, Commercial or Industrial |
| Transaction type | Resale, Lease/Rent or New project |
| Raw record | A row exactly as uploaded |
| Sighting | One raw appearance of a record; a record can have many |
| Repost | The same ad appearing again (another day, newspaper or file) |
| Person / Contact | A person or phone number with roles; one person can link to many records |
| Match | A ranked pairing of a Demand with an Offer or a bundle of Offers |
| Bundle | Two or more offers matched together to meet one requirement |
| Life curve | Days since a record was last confirmed, with category thresholds and automatic actions |
| Last confirmed / last seen | Last call, meeting or visit confirming a record / last sighting of it in an upload |
| Must call / Should call | Supply call queues: interest or match first; proactive vetting and reconfirmation when capacity allows |
| Sourcing request | The demand team's request to the supply team to find supply for a demand |
| In process | Deal stage after site visit covering negotiation, contract work and registration |
| Lost / Dormant / Invalid | Demand exits: closed elsewhere or withdrawn / postponed with a revisit date / fake, unreachable or not a real client |
| Upcoming | An offer whose Available from date is in the future |
| Publication level | Private, Anonymous or Public |
| Tenant | A customer organisation. Phase 1 has one tenant (11 Estates) |
