# Input: "Demand and supply journeys in the 11 Estates CRM" (Vinit)

| | |
|---|---|
| Source | https://claude.ai/artifact/YSBWDq2b5stchAJopyYyeY (shared from another organisation) |
| Author | Vinit (11 Estates) |
| Read on | 2026-09-24 |
| Relation | Interactive companion to BRD v0.5 (`docs/inputs/CRM-01-brd-v0.5.pdf`) |

## What it is
An interactive explainer with three tabs: **Demand journey**, **Supply journey** and **Dashboard**. On the demand side
you pick the source (Channel / Digi / Direct), whether inventory matches (Yes / No, source supply) and the ending
(Closed / Lost / Dormant / Invalid). On the supply side you pick a situation. You then step through with Previous/Next.
Each step shows who acts, the rows written, the record's status axes (Record, Publication, Commercial), the life curve,
signals and call queue, and the effect on the dashboard tiles. The dashboard follows both tabs.

It adds no new business rules beyond BRD v0.5. Its value is the **worked scenarios** below. The PRD uses them as
end-to-end acceptance scenarios and the prototype uses them as sample data.

## People in the scenarios
- **Priyanka**: demand team. **Vinit**: supply team (also takes Direct referrals).
- Anil (broker), Rohan Mehta (client, admin head at a fintech), Mr Shah (referrer), Sanjay / Rakesh / Ramesh (brokers),
  Mrs Kapoor and Mr Desai (owners), a developer for PRJ-0031.

## Demand scenario: DEM-000127, Commercial Lease, office 5,000–7,000 sq ft built up, Andheri East / Marol, ₹8–10 L/month, move in within 60 days
1. **Capture.** Three variants:
   - Channel: Anil posts in a broker WhatsApp group.
   - Digi: Rohan fills a Meta lead ad (ENQ-0311 with campaign ID).
   - Direct: Mr Shah refers Rohan, and Vinit types it in with quick add (phone lookup first; referrer linked).
   The duplicate check finds nothing, DEM-000127 is created, and it lands in the To contact or To qualify queue. The life curve starts.
2. **Invalid branch.** One of three ends the demand as Invalid and flags the person:
   - Anil is collecting inventory and has no real client, so he gets anonymous shares only.
   - The number is unreachable after 3 attempts.
   - Rohan turns out to be a broker, so he moves to People as a Broker.
3. **Understand / qualify.** Priyanka pins down 5–7k sq ft built up, ₹8–10 L, a 60-day window and CFO sign-off. The life curve resets.
4. **Second touch.** The same demand arrives from another source and is merged as a touch. The first touch keeps the
   credit, for example Anil's shared commission or Mr Shah's referral.
5. **Check inventory.**
   - Yes: 3 matches (MAT-0045/46/47), one of them a 2-offer **bundle** of adjacent Marol floors (3,200 + 3,000 sq ft).
   - No: sourcing. SRQ goes to the supply team, an anonymous demand post goes up, and **Add supply** creates INV-00611/12/13
     tagged "Sourced for DEM-000127". INV-00611 turns out to be leased already and its match is dropped. The rest are verified and the post comes down.
6. **Proposal** with photos, built up/carpet area, rent, availability and building names.
7. Endings:
   - **Dormant:** the demand ages (31 days, Commercial Lease) and a reconfirm call follows. The CFO postpones to April, so the demand becomes Dormant with a revisit date of 1 March and its matches are released.
   - **Site visit → In process:** DEAL-0019 settles at ₹8.3–8.4 L with a 3-month fitout. Follow ups every 2 days reset the life curve.
   - **Lost:** the client signs in Powai for 2 months rent free. The competing terms are recorded and the matches released.
   - **Closed:** the agreement is registered, Anil's share is recorded, and the other matched demands are notified.

## Supply scenarios
- **Interest first (PRP-00210 / INV-00452).**
  - A broker post (Sanjay, "5000 sqft furnished office Andheri East. 8L") becomes Should call rank 38 and is published anonymously.
  - Rakesh posts the same office at ₹8.2 L. It is linked as a second source with the price gap flagged.
  - An enquiry moves it to Must call (24 h).
  - The call confirms ₹8.5 L and adds sale offer INV-00453 (₹11 Cr) on the same property.
  - A visit verifies both offers, which go Public, and a revenue share is agreed.
  - INV-00452 matches 3 demands; the sale offer matches an investor.
  - The lease closes at ₹8.3 L and the other demands are notified ("Leased to another client").
  - The sale offer becomes "Sale with tenant in place".
- **Proactive vetting.** A newspaper classified (Andheri W 2BHK, 75K, owner) ranks Should call #4 because of a demand gap
  (12 open rent demands). Mrs Kapoor confirms and sends 9 photos, which counts as permission, so it goes straight to Public. It matches 2 rent demands.
- **Sourced for a demand.** SRQ-014 → Add supply → PRP-00262 / INV-00612 at Contacted, matched on creation, kept Private by
  choice. It then goes through verify, qualify (revenue share with Sanjay), site visit, In process and Closed.
- **Ageing record.** A 3,500 sq ft Marol office from Ramesh, Verified and Public:
  - Day 31: Ageing, so it goes on Should call.
  - Day 61: Stale, so Public drops to Anonymous.
  - Day 91: Expired, so it is unpublished and flagged "Availability unknown".
  - The reconfirm call finds it leased at ₹5 L, so it becomes Inactive and the price is kept as market data.
- **Future availability.** Mr Desai's office is free from 1 Feb, so it becomes Upcoming INV-00701.
  - It is published anonymously with the date.
  - The fintech is excluded ("Available too late") and a logistics firm is matched.
  - The clock starts 60 days before the date. A reconfirm verifies it, it goes Public, and there is a visit on 1 Feb.
  - Every 11-month lease 11 Estates closes creates an Upcoming offer at month 10.
- **New project.** PRJ-0031 has INV-00801 (2 BHK ₹2.40 Cr, 38 units) and INV-00802 (3 BHK ₹3.40 Cr, 22 units), which start Verified from the developer sheet.
  - 11 enquiries arrive and the 2 BHK holds 4 matches, one buyer also matched to resale INV-00655.
  - A new sheet raises the price and lowers the units, so one match is flagged "price above budget".
  - The offer turns Ageing, so a task goes out to request the latest sheet.
  - A booking reduces the unit count while the offer stays live.

## Points to reconcile (raised in CR-002)
- The artifact labels Channel capture "Automatic: n8n WhatsApp ingestion" and Digi capture "Automatic: Meta lead ad
  webhook". BRD v0.5 says connectors are **next phase** and Phase 1 uses file upload and manual entry only. We treat the
  BRD as authoritative and read those labels as the future state.
