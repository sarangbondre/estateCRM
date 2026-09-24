# Event catalogue (generated)

Delivery: at least once; ordering per aggregate; dedupe on eventId. Source: `contracts/asyncapi/events.yaml`.

| Event | Producer | Consumers | Meaning |
|---|---|---|---|
| `upload.started.v1` | intake | insight | An upload began processing. |
| `rows.classified.v1` | intake | records, insight | A batch (≤500) of classified rows is ready. Carries no PII: records pulls contact fields via intake GET /internal/v1/uploads/{uploadId}/rows?batch=. |
| `upload.completed.v1` | intake | web, insight | All batches of an upload were emitted. |
| `upload.failed.v1` | intake | web, insight | An upload could not be processed. |
| `review_item.created.v1` | intake | insight | A row needs classification review. |
| `review_item.resolved.v1` | intake | records, insight | A classification review item was resolved by a person. |
| `offer.created.v1` | records | journeys, crm-engine, listings, insight | A new Offer exists (from intake, quick add, Add supply, price sheet or renewal). |
| `offer.updated.v1` | records | journeys, crm-engine, listings, insight | Offer or its Property facts changed (full current facts). |
| `offer.price_changed.v1` | records | journeys, crm-engine, listings, insight | Price fields changed. |
| `offer.record_stage_changed.v1` | records | journeys, listings, insight | Record axis moved (e.g. Contacted → Verified). |
| `demand.created.v1` | records | journeys, crm-engine, listings, insight | A new Demand exists. |
| `demand.updated.v1` | records | journeys, crm-engine, listings, insight | Demand facts changed (full current facts). |
| `demand.touch_added.v1` | records | journeys, insight | Another arrival of the same demand (first touch unchanged). |
| `enquiry.received.v1` | records | journeys, insight | A market enquiry linked to an offer/project/campaign. |
| `records.merged.v1` | records | journeys, crm-engine, listings, insight | Two records were merged (reversible). |
| `records.merge_undone.v1` | records | journeys, crm-engine, listings, insight | A merge was undone. |
| `person.flagged.v1` | records | journeys, insight | A person got a flag (invalid, broker-posing, unwilling, anonymous-shares-only). |
| `watchlist_item.created.v1` | records | journeys, insight | A Market Signal was stored; needs a supply follow-up task. |
| `vocabulary.released.v1` | records | intake, crm-engine, listings, insight | A new controlled-vocabulary release is active. |
| `photo.added.v1` | records | listings, insight | Photo attached to a property. |
| `photo.removed.v1` | records | listings, insight | Photo detached or deleted. |
| `project.created.v1` | records | listings, insight | A Project (Sale, Primary) exists. |
| `project.updated.v1` | records | listings, insight | Project facts changed (full current facts). |
| `price_sheet.applied.v1` | records | journeys, crm-engine, insight | A developer price sheet was applied to a project (life-curve basis for Sale, Primary). |
| `offer.voided.v1` | records | journeys, crm-engine, listings, insight | An offer was voided because review changed its side or scope (it was not supply). |
| `demand.voided.v1` | records | journeys, crm-engine, listings, insight | A demand was voided because review changed its side or scope. |
| `person.flag_removed.v1` | records | journeys, insight | A person flag was removed. |
| `desk_item.created.v1` | records | insight | A Business, Capital, Equipment or Market Participant record was stored. |
| `desk_item.updated.v1` | records | insight | A desk item changed (assigned, archived). |
| `merge_candidate.raised.v1` | records | insight | An uncertain merge or price gap needs review. |
| `market_data.recorded.v1` | records | insight | A closed or reported price was kept as market data (ours, elsewhere, or reported). |
| `micromarkets.updated.v1` | records | crm-engine, listings, insight | The micromarket hierarchy or adjacency changed. |
| `offer.confirmed.v1` | journeys | records, crm-engine, listings, insight | Offer confirmed on a call/visit/price sheet; life curve reset. |
| `demand.confirmed.v1` | journeys | crm-engine, insight | Demand reconfirmed; life curve reset. |
| `lifecycle.stage_changed.v1` | journeys | crm-engine, listings, insight | Life curve stage changed. |
| `offer.commercial_status_changed.v1` | journeys | crm-engine, listings, insight | Offer Commercial axis changed. |
| `demand.qualified.v1` | journeys | crm-engine, insight | Demand qualified; run inventory check. |
| `demand.status_changed.v1` | journeys | crm-engine, listings, insight | Demand Commercial axis changed. |
| `demand.exited.v1` | journeys | records, crm-engine, listings, insight | Demand exited Lost/Dormant/Invalid. |
| `demand.reactivated.v1` | journeys | records, crm-engine, insight | Dormant demand returned to Active. |
| `demand.sourcing_started.v1` | journeys | listings, insight | Demand in Sourcing; anonymous demand post allowed. |
| `sourcing_request.created.v1` | journeys | insight | Sourcing request raised. |
| `proposal.sent.v1` | journeys | crm-engine, insight | Proposal marked sent. |
| `site_visit.completed.v1` | journeys | records, crm-engine, insight | Visit done; resets both life curves. |
| `deal.opened.v1` | journeys | crm-engine, insight | Deal entered In process. |
| `deal.closed.v1` | journeys | records, crm-engine, listings, insight | Deal closed; offer closed. |
| `deal.cancelled.v1` | journeys | records, crm-engine, listings, insight | Deal cancelled; offer back to Available, demand to Active (compensation). |
| `offer.retired.v1` | journeys | records, crm-engine, listings, insight | Offer Inactive (already gone / unwilling). |
| `lease_renewal.due.v1` | journeys | records | Month 10 of an 11-month lease closed by 11 Estates: create an Upcoming offer. |
| `watchlist_task.completed.v1` | journeys | insight | Supply follow-up on a Market Signal done. |
| `call.logged.v1` | journeys | records, insight | A call outcome was recorded. |
| `site_visit.scheduled.v1` | journeys | insight | A site visit was scheduled. |
| `sourcing_request.updated.v1` | journeys | insight | Sourcing request status changed. |
| `proposal.feedback_recorded.v1` | journeys | crm-engine, insight | Client feedback on proposal options (feeds match usefulness M6). |
| `deal.updated.v1` | journeys | insight | Deal stage or follow-up changed. |
| `queue.counts_changed.v1` | journeys | insight | Per-user queue section counts changed (debounced ≤ 1/min per user). |
| `match.suggested.v1` | crm-engine | journeys, insight | New or re-ranked suggestion. |
| `match.confirmed.v1` | crm-engine | journeys, listings, insight | A person confirmed a match. |
| `match.rejected.v1` | crm-engine | journeys, insight | A person rejected a match. |
| `match.closed.v1` | crm-engine | journeys, insight | Match closed automatically (offer closed/retired, demand exited). |
| `match.flagged.v1` | crm-engine | journeys, insight | Match flag raised (price above budget, reconfirm, area/market unknown). |
| `demand.matching_completed.v1` | crm-engine | journeys, insight | Inventory check for a demand finished (after qualify or re-run). |
| `match.reopened.v1` | crm-engine | journeys, insight | A closed match reopened (compensation, e.g. deal cancelled or merge undone). |
| `publication.changed.v1` | listings | records, journeys, insight | Publication level of an offer/project/demand post changed. |
| `export.completed.v1` | insight | web | Export file ready (24 h link). |
| `export.failed.v1` | insight | web | Export could not be produced. |
| `user.changed.v1` | web | journeys, insight | A staff user was invited, changed role, or deactivated. |
| `audit.recorded.v1` | * | web | Sensitive action for the audit log (contact view, export, merge/undo, publication, exit, deal close, settings). Automatic actions use the reserved system user 00000000-0000-0000-0000-000000000001. |
