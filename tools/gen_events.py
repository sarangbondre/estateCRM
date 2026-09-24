"""Generates contracts/asyncapi/events.yaml from a single event catalogue.
Run: python3 tools/gen_events.py  (no third-party deps)."""
import json, pathlib

S = lambda t, **k: {"type": t, **k}
UUID = S("string", format="uuid")
CODE = S("string", description="Display code, e.g. INV-00452")
DATE = S("string", format="date")
DT = S("string", format="date-time")
INR = S("integer", minimum=0, description="INR")
NUM = S("number")
VOC = lambda f, arr=False: ({"type": "array", "items": {"type": "string"}, "x-vocabulary": f} if arr else {"type": "string", "x-vocabulary": f})
def obj(req, **props): return {"type": "object", "additionalProperties": False, "required": req, "properties": props}

CLASSIFICATION = dict(recordScope=S("string", enum=["Property","Business","Capital","Equipment","Market Participant","Market Signal"]),
    side=S("string", enum=["Supply","Demand","None"], nullable=True), dealTypes=VOC("deal_type", True), market=VOC("market"),
    segment=VOC("segment"), propertyTypes=VOC("property_type", True))
OFFER_FACTS = obj(["offerId","code","propertyId","dealType"], offerId=UUID, code=CODE, propertyId=UUID, projectId=UUID,
    dealType=VOC("deal_type"), market=VOC("market"), segment=VOC("segment"), propertyTypes=VOC("property_type", True),
    bhkMin=NUM, bhkMax=NUM, areaSqftMin=NUM, areaSqftMax=NUM, areaBasis=S("string", enum=["Carpet","Builtup","Saleable"], nullable=True),
    landAreaSqft=NUM, salePriceInrMin=INR, salePriceInrMax=INR, rentMonthlyInrMin=INR, rentMonthlyInrMax=INR, depositInr=INR, currentRentInr=INR,
    locality=S("string"), micromarket=S("string"), city=S("string"), outsideLaunchArea=S("boolean"),
    tenancyStatus=VOC("tenancy_status"), saleMode=VOC("sale_mode"), possessionStatus=VOC("possession_status"), possessionDate=S("string"),
    furnishing=VOC("furnishing"), unitCount=S("integer"), recordStage=S("string", enum=["Captured","Enriched","Contacted","Verified","Qualified"]),
    photoCount=S("integer"), hasRealPhotos=S("boolean"), selectedPhotoIds=S("array", items=UUID), sourceType=S("string", enum=["Channel","Digi","Direct"]), sourcedForDemandId=UUID,
    ownerUserId=UUID, contactPersonIds=S("array", items=UUID), buildingKey=S("string", description="Opaque hash of building identity (no name); same value = same building"),
    floorBand=S("string", enum=["Low","Mid","High"]), totalFloors=S("integer"), parking=S("integer"), amenities=S("array", items=S("string")), tenure=VOC("tenure"), agreementForm=VOC("agreement_form"), isJodi=S("boolean"),
    priceSheetDate=DATE, lastSeenDate=DATE, publicDescriptionSource=S("string", description="Sanitisable description text id reference; the text itself is fetched from records"), projectCode=CODE)
DEMAND_FACTS = obj(["demandId","code","dealTypes"], demandId=UUID, code=CODE, dealTypes=VOC("deal_type", True), market=VOC("market"),
    segment=VOC("segment"), propertyTypes=VOC("property_type", True), bhkMin=NUM, bhkMax=NUM, areaSqftMin=NUM, areaSqftMax=NUM,
    areaBasis=S("string", enum=["Carpet","Builtup","Saleable"], nullable=True), budgetInrMin=INR, budgetInrMax=INR, rentMonthlyInrMin=INR, rentMonthlyInrMax=INR,
    micromarkets=S("array", items=S("string")), localities=S("array", items=S("string")), moveInBy=DATE, statedTags=S("object", additionalProperties=S("string")),
    outsideLaunchArea=S("boolean"), recordStage=S("string", enum=["Captured","Enriched","Verified","Qualified"]), sourceType=S("string", enum=["Channel","Digi","Direct"]),
    ownerUserId=UUID, contactPersonIds=S("array", items=UUID), moveInFrom=DATE, lastSeenDate=DATE)

C = "consumers"
EVENTS = [
 # ---------- intake
 ("upload.started.v1","intake",["insight"],"An upload began processing.", obj(["uploadId","code","mode","rowCount","uploadedBy"], uploadId=UUID, code=CODE, mode=S("string", enum=["strict","mapping"]), sourceType=S("string"), sourceDetail=S("string"), rowCount=S("integer"), anonymised=S("boolean"), uploadedBy=UUID)),
 ("rows.classified.v1","intake",["records","insight"],"A batch (≤500) of classified rows is ready. Carries no PII: records pulls contact fields via intake GET /internal/v1/uploads/{uploadId}/rows?batch=.", obj(["uploadId","batchNo","rows"], uploadId=UUID, batchNo=S("integer"), anonymised=S("boolean"), migrationApplied=S("boolean", description="true when this upload carried a migration_map that records must apply before these rows (CR-006 Z-5)"),
   rows=S("array", maxItems=500, items=obj(["rowId","externalRef"], rowId=UUID, externalRef=S("string", description="extractor record_id"), parentExternalRef=S("string"), splitIndex=S("string"), **CLASSIFICATION,
     needsReview=S("boolean"), reviewReasonCode=S("string", enum=["side_defaulted","deal_type_missing","side_unclear","property_type_missing","value_not_translatable","model_unavailable","low_confidence","other"]), possibleRepeatOf=S("string"),
     firstSeenDate=DATE, lastSeenDate=DATE, timesSeen=S("integer"), sourceType=S("string"), sourceName=S("string"), sourceDate=DATE, contentHash=S("string"))))),
 ("upload.completed.v1","intake",["web","insight"],"All batches of an upload were emitted.", obj(["uploadId","code","counts","uploadedBy"], uploadId=UUID, code=CODE, counts=obj(["read","accepted","rejected","needsReview"], read=S("integer"), accepted=S("integer"), rejected=S("integer"), needsReview=S("integer"), unchanged=S("integer")), rejectionReasons=S("object", additionalProperties=S("integer"), description="error code → count"), sourceType=S("string"), sourceDetail=S("string"), uploadedBy=UUID)),
 ("upload.failed.v1","intake",["web","insight"],"An upload could not be processed.", obj(["uploadId","code","reason","uploadedBy"], uploadId=UUID, code=CODE, reason=S("string"), uploadedBy=UUID)),
 ("review_item.created.v1","intake",["insight"],"A row needs classification review.", obj(["reviewItemId","uploadId","reasonCode"], reviewItemId=UUID, uploadId=UUID, rowId=UUID, reasonCode=S("string"), detailCode=S("string", description="Finer cause, e.g. field name that failed"))),
 ("review_item.resolved.v1","intake",["records","insight"],"A classification review item was resolved by a person.", obj(["reviewItemId","rowId","externalRef","uploadId","action"], reviewItemId=UUID, uploadId=UUID, rowId=UUID, externalRef=S("string"), action=S("string", enum=["set","confirm","discard"]), **CLASSIFICATION, resolvedBy=UUID)),
 # ---------- records
 ("offer.created.v1","records",["journeys","crm-engine","listings","insight"],"A new Offer exists (from intake, quick add, Add supply, price sheet or renewal).", OFFER_FACTS),
 ("offer.updated.v1","records",["journeys","crm-engine","listings","insight"],"Offer or its Property facts changed (full current facts).", OFFER_FACTS),
 ("offer.price_changed.v1","records",["journeys","crm-engine","listings","insight"],"Price fields changed.", obj(["offerId","previous","current"], offerId=UUID, previous=obj([], salePriceInrMin=INR, salePriceInrMax=INR, rentMonthlyInrMin=INR, rentMonthlyInrMax=INR, depositInr=INR, currentRentInr=INR, unitCount=S("integer")), current=obj([], salePriceInrMin=INR, salePriceInrMax=INR, rentMonthlyInrMin=INR, rentMonthlyInrMax=INR, depositInr=INR, currentRentInr=INR, unitCount=S("integer")), cause=S("string", enum=["edit","call","price_sheet","upload"]))),
 ("offer.record_stage_changed.v1","records",["journeys","listings","insight"],"Record axis moved (e.g. Contacted → Verified).", obj(["offerId","from","to"], offerId=UUID, **{"from":S("string")}, to=S("string"), hasRealPhotos=S("boolean"), changedBy=UUID)),
 ("demand.created.v1","records",["journeys","crm-engine","listings","insight"],"A new Demand exists.", DEMAND_FACTS),
 ("demand.updated.v1","records",["journeys","crm-engine","listings","insight"],"Demand facts changed (full current facts).", DEMAND_FACTS),
 ("demand.touch_added.v1","records",["journeys","insight"],"Another arrival of the same demand (first touch unchanged).", obj(["demandId","touchId","sourceType","isFirstTouch"], demandId=UUID, touchId=UUID, sourceType=S("string"), captureMode=S("string"), isFirstTouch=S("boolean"))),
 ("enquiry.received.v1","records",["journeys","insight"],"A market enquiry linked to an offer/project/campaign.", obj(["enquiryId","code"], enquiryId=UUID, code=CODE, offerId=UUID, projectId=UUID, campaignRef=S("string"), demandId=UUID, receivedAt=DT)),
 ("records.merged.v1","records",["journeys","crm-engine","listings","insight"],"Two records were merged (reversible).", obj(["mergeId","aggregateType","survivorId","mergedIds"], mergeId=UUID, aggregateType=S("string", enum=["property","offer","demand","person"]), survivorId=UUID, mergedIds=S("array", items=UUID))),
 ("records.merge_undone.v1","records",["journeys","crm-engine","listings","insight"],"A merge was undone.", obj(["mergeId","aggregateType","restoredIds"], mergeId=UUID, aggregateType=S("string"), restoredIds=S("array", items=UUID))),
 ("person.flagged.v1","records",["journeys","insight"],"A person got a flag (invalid, broker-posing, unwilling, anonymous-shares-only).", obj(["personId","flag"], personId=UUID, flag=S("string"), reason=S("string"))),
 ("watchlist_item.created.v1","records",["journeys","insight"],"A Market Signal was stored; needs a supply follow-up task.", obj(["watchlistItemId","code","signalType"], watchlistItemId=UUID, code=CODE, signalType=VOC("signal_type"), deadlineDate=DATE)),
 ("vocabulary.released.v1","records",["intake","crm-engine","listings","insight"],"A new controlled-vocabulary release is active.", obj(["version","checksum"], version=S("string"), checksum=S("string"))),
 ("photo.added.v1","records",["listings","insight"],"Photo attached to a property.", obj(["photoId","propertyId","origin","storagePath"], photoId=UUID, propertyId=UUID, origin=S("string", enum=["call","visit","source_share","sheet_link","upload"]), isReal=S("boolean"), storagePath=S("string", description="records bucket path; public renditions are produced by listings"), hasTextDetected=S("boolean"))),
 ("photo.removed.v1","records",["listings","insight"],"Photo detached or deleted.", obj(["photoId","propertyId"], photoId=UUID, propertyId=UUID)),
 ("project.created.v1","records",["listings","insight"],"A Project (Sale, Primary) exists.", obj(["projectId","code","name"], projectId=UUID, code=CODE, name=S("string"), developerPersonId=UUID, developerName=S("string", description="Developer business name (not personal data)"), reraNumber=S("string"), locality=S("string"), micromarket=S("string"), city=S("string"), possessionDate=S("string"), amenities=S("array", items=S("string")), offerIds=S("array", items=UUID))),
 ("project.updated.v1","records",["listings","insight"],"Project facts changed (full current facts).", obj(["projectId","code","name"], projectId=UUID, code=CODE, name=S("string"), developerPersonId=UUID, developerName=S("string", description="Developer business name (not personal data)"), reraNumber=S("string"), locality=S("string"), micromarket=S("string"), city=S("string"), possessionDate=S("string"), amenities=S("array", items=S("string")), offerIds=S("array", items=UUID))),
 ("price_sheet.applied.v1","records",["journeys","crm-engine","insight"],"A developer price sheet was applied to a project (life-curve basis for Sale, Primary).", obj(["projectId","priceSheetId","sheetDate"], projectId=UUID, priceSheetId=UUID, sheetDate=DATE, changedOfferIds=S("array", items=UUID))),
 ("offer.voided.v1","records",["journeys","crm-engine","listings","insight"],"An offer was voided because review changed its side or scope (it was not supply).", obj(["offerId","reason"], offerId=UUID, reason=S("string", enum=["side_changed","scope_changed","duplicate_discarded"]))),
 ("demand.voided.v1","records",["journeys","crm-engine","listings","insight"],"A demand was voided because review changed its side or scope.", obj(["demandId","reason"], demandId=UUID, reason=S("string", enum=["side_changed","scope_changed","duplicate_discarded"]))),
 ("person.flag_removed.v1","records",["journeys","insight"],"A person flag was removed.", obj(["personId","flag"], personId=UUID, flag=S("string"))),
 ("desk_item.created.v1","records",["insight"],"A Business, Capital, Equipment or Market Participant record was stored.", obj(["deskItemId","code","recordScope"], deskItemId=UUID, code=CODE, recordScope=S("string"), dealTypes=VOC("deal_type", True), side=S("string"), sector=VOC("sector"), participantRole=VOC("participant_role"), linkedPropertyId=UUID)),
 ("desk_item.updated.v1","records",["insight"],"A desk item changed (assigned, archived).", obj(["deskItemId","status"], deskItemId=UUID, status=S("string", enum=["open","assigned","archived"]), assigneeUserId=UUID)),
 ("merge_candidate.raised.v1","records",["insight"],"An uncertain merge or price gap needs review.", obj(["candidateId","kind"], candidateId=UUID, kind=S("string", enum=["uncertain_merge","possible_repeat","price_gap"]), aggregateType=S("string"))),
 ("market_data.recorded.v1","records",["insight"],"A closed or reported price was kept as market data (ours, elsewhere, or reported).", obj(["marketDataId","kind"], marketDataId=UUID, kind=S("string", enum=["closed_by_us","closed_elsewhere","reported"]), segment=VOC("segment"), dealType=VOC("deal_type"), micromarket=S("string"), priceInr=INR, areaSqft=NUM, recordedOn=DATE)),
 ("micromarkets.updated.v1","records",["crm-engine","listings","insight"],"The micromarket hierarchy or adjacency changed.", obj(["version"], version=S("integer"))),
 # ---------- journeys
 ("offer.confirmed.v1","journeys",["records","crm-engine","listings","insight"],"Offer confirmed on a call/visit/price sheet; life curve reset.", obj(["offerId","confirmedAt","how"], offerId=UUID, confirmedAt=DT, how=S("string", enum=["call","meeting","visit","price_sheet"]))),
 ("demand.confirmed.v1","journeys",["crm-engine","insight"],"Demand reconfirmed; life curve reset.", obj(["demandId","confirmedAt","how"], demandId=UUID, confirmedAt=DT, how=S("string"))),
 ("lifecycle.stage_changed.v1","journeys",["crm-engine","listings","insight"],"Life curve stage changed.", obj(["subjectType","subjectId","from","to","day"], subjectType=S("string", enum=["offer","demand"]), subjectId=UUID, **{"from":S("string")}, to=S("string", enum=["Fresh","Ageing","Stale","Expired","Paused"]), day=S("integer"))),
 ("offer.commercial_status_changed.v1","journeys",["crm-engine","listings","insight"],"Offer Commercial axis changed.", obj(["offerId","from","to"], offerId=UUID, **{"from":S("string")}, to=S("string", enum=["Upcoming","Available","Matched","In proposal","Site visit","In process","Closed","Inactive"]), reason=S("string"))),
 ("demand.qualified.v1","journeys",["crm-engine","insight"],"Demand qualified; run inventory check.", obj(["demandId"], demandId=UUID)),
 ("demand.status_changed.v1","journeys",["crm-engine","listings","insight"],"Demand Commercial axis changed.", obj(["demandId","from","to"], demandId=UUID, **{"from":S("string")}, to=S("string"))),
 ("demand.exited.v1","journeys",["records","crm-engine","listings","insight"],"Demand exited Lost/Dormant/Invalid.", obj(["demandId","exit"], demandId=UUID, exit=S("string", enum=["Lost","Dormant","Invalid"]), revisitDate=DATE, reason=S("string"), competingTerms=S("string", description="Business terms only, no PII (e.g. 'Powai, 2 months rent free')"), competingPriceInr=INR, flagPerson=S("boolean"), personId=UUID)),
 ("demand.reactivated.v1","journeys",["records","crm-engine","insight"],"Dormant demand returned to Active.", obj(["demandId"], demandId=UUID)),
 ("demand.sourcing_started.v1","journeys",["listings","insight"],"Demand in Sourcing; anonymous demand post allowed.", obj(["demandId","postAnonymously"], demandId=UUID, postAnonymously=S("boolean"), sourcingRequestId=UUID)),
 ("sourcing_request.created.v1","journeys",["insight"],"Sourcing request raised.", obj(["sourcingRequestId","code","demandId","assigneeUserId"], sourcingRequestId=UUID, code=CODE, demandId=UUID, assigneeUserId=UUID, dueDate=DATE, priority=S("string"))),
 ("proposal.sent.v1","journeys",["crm-engine","insight"],"Proposal marked sent.", obj(["proposalId","demandId","matchIds"], proposalId=UUID, demandId=UUID, matchIds=S("array", items=UUID))),
 ("site_visit.completed.v1","journeys",["records","crm-engine","insight"],"Visit done; resets both life curves.", obj(["visitId","demandId","offerIds"], visitId=UUID, demandId=UUID, offerIds=S("array", items=UUID), preferredOfferId=UUID)),
 ("deal.opened.v1","journeys",["crm-engine","insight"],"Deal entered In process.", obj(["dealId","code","demandId","offerId"], dealId=UUID, code=CODE, demandId=UUID, offerId=UUID)),
 ("deal.closed.v1","journeys",["records","crm-engine","listings","insight"],"Deal closed; offer closed.", obj(["dealId","demandId","offerId","closedAt"], dealId=UUID, demandId=UUID, offerId=UUID, closedAt=DT, closingPriceInr=INR, dealType=VOC("deal_type"), leaseMonths=S("integer"), unitsBooked=S("integer"))),
 ("deal.cancelled.v1","journeys",["records","crm-engine","listings","insight"],"Deal cancelled; offer back to Available, demand to Active (compensation).", obj(["dealId","demandId","offerId","reason"], dealId=UUID, demandId=UUID, offerId=UUID, reason=S("string"))),
 ("offer.retired.v1","journeys",["records","crm-engine","listings","insight"],"Offer Inactive (already gone / unwilling).", obj(["offerId","reason"], offerId=UUID, reason=S("string", enum=["already_gone","unwilling","other"]), knownPriceInr=INR)),
 ("lease_renewal.due.v1","journeys",["records"],"Month 10 of an 11-month lease closed by 11 Estates: create an Upcoming offer.", obj(["propertyId","previousOfferId","availableFrom"], propertyId=UUID, previousOfferId=UUID, availableFrom=DATE)),
 ("watchlist_task.completed.v1","journeys",["insight"],"Supply follow-up on a Market Signal done.", obj(["taskId","watchlistItemId"], taskId=UUID, watchlistItemId=UUID, outcome=S("string"))),
 ("call.logged.v1","journeys",["records","insight"],"A call outcome was recorded.", obj(["callId","subjectType","subjectId","outcome"], callId=UUID, subjectType=S("string", enum=["offer","demand"]), subjectId=UUID, personId=UUID, outcome=S("string", enum=["confirmed","no_answer","already_gone","unwilling"]), attempt=S("integer"), personUnreachable=S("boolean"), calledBy=UUID)),
 ("site_visit.scheduled.v1","journeys",["insight"],"A site visit was scheduled.", obj(["visitId","demandId","offerIds","scheduledFor"], visitId=UUID, demandId=UUID, offerIds=S("array", items=UUID), scheduledFor=DT)),
 ("sourcing_request.updated.v1","journeys",["insight"],"Sourcing request status changed.", obj(["sourcingRequestId","status"], sourcingRequestId=UUID, status=S("string", enum=["open","in_progress","fulfilled","cancelled"]))),
 ("proposal.feedback_recorded.v1","journeys",["crm-engine","insight"],"Client feedback on proposal options (feeds match usefulness M6).", obj(["proposalId","demandId","feedback"], proposalId=UUID, demandId=UUID, feedback=S("array", items=obj(["matchId","verdict"], matchId=UUID, verdict=S("string", enum=["liked","rejected","visit_requested"]))))),
 ("deal.updated.v1","journeys",["insight"],"Deal stage or follow-up changed.", obj(["dealId","stage","followUpDate"], dealId=UUID, stage=S("string"), followUpDate=DATE, overdue=S("boolean"))),
 ("queue.counts_changed.v1","journeys",["insight"],"Per-user queue section counts changed (debounced ≤ 1/min per user).", obj(["userId","counts"], userId=UUID, counts=S("object", additionalProperties=S("integer"), propertyNames={"enum":["must_call","should_call","sourcing_requests","watchlist_tasks","to_contact","to_qualify","reconfirm_due","needs_sourcing","in_sourcing","sourcing_requests_open","open_matches","proposals_out","site_visits_this_week","deals_follow_up","dormant_revisits"]}))),
 # ---------- crm-engine
 ("match.suggested.v1","crm-engine",["journeys","insight"],"New or re-ranked suggestion.", obj(["matchId","code","demandId","offerIds","score"], matchId=UUID, code=CODE, demandId=UUID, offerIds=S("array", items=UUID, minItems=1), isBundle=S("boolean"), score=S("integer", minimum=0, maximum=100), flags=S("array", items=S("string")))),
 ("match.confirmed.v1","crm-engine",["journeys","listings","insight"],"A person confirmed a match.", obj(["matchId","demandId","offerIds"], matchId=UUID, demandId=UUID, offerIds=S("array", items=UUID), confirmedBy=UUID)),
 ("match.rejected.v1","crm-engine",["journeys","insight"],"A person rejected a match.", obj(["matchId","demandId","reason"], matchId=UUID, demandId=UUID, reason=S("string"))),
 ("match.closed.v1","crm-engine",["journeys","insight"],"Match closed automatically (offer closed/retired, demand exited).", obj(["matchId","demandId","reason"], matchId=UUID, demandId=UUID, reason=S("string", enum=["leased_to_another_client","sold_to_another_client","offer_retired","offer_expired","demand_exited","demand_closed","deal_closed","superseded","merged","voided"]))),
 ("match.flagged.v1","crm-engine",["journeys","insight"],"Match flag raised (price above budget, reconfirm, area/market unknown).", obj(["matchId","flag","cleared"], matchId=UUID, flag=S("string", enum=["price_above_budget","reconfirm","area_basis_unknown","market_unknown"]), cleared=S("boolean", description="true when the flag is removed"))),
 ("demand.matching_completed.v1","crm-engine",["journeys","insight"],"Inventory check for a demand finished (after qualify or re-run).", obj(["demandId","runId","matchCount"], demandId=UUID, runId=UUID, matchCount=S("integer"), bundleCount=S("integer"))),
 ("match.reopened.v1","crm-engine",["journeys","insight"],"A closed match reopened (compensation, e.g. deal cancelled or merge undone).", obj(["matchId","demandId","reason"], matchId=UUID, demandId=UUID, reason=S("string", enum=["deal_cancelled","merge_undone","offer_reactivated","demand_reactivated"]))),
 # ---------- listings
 ("publication.changed.v1","listings",["records","journeys","insight"],"Publication level of an offer/project/demand post changed.", obj(["subjectType","subjectId","from","to","reason"], subjectType=S("string", enum=["offer","project","demand_post"]), subjectId=UUID, **{"from":S("string")}, to=S("string", enum=["Private","Anonymous","Public"]), reason=S("string", enum=["user","ceiling_dropped","closed","retired","expired","merged","voided"]), publicId=S("string"))),
 # ---------- insight
 ("export.completed.v1","insight",["web"],"Export file ready (24 h link).", obj(["exportId","code","rowCount","requestedBy"], exportId=UUID, code=CODE, rowCount=S("integer"), requestedBy=UUID, includesPii=S("boolean"))),
 ("export.failed.v1","insight",["web"],"Export could not be produced.", obj(["exportId","code","requestedBy","reason"], exportId=UUID, code=CODE, requestedBy=UUID, reason=S("string"))),
 ("user.changed.v1","web",["journeys","insight"],"A staff user was invited, changed role, or deactivated.", obj(["userId","role","active"], userId=UUID, role=S("string", enum=["Admin","Manager","Demand agent","Supply agent","Data operator"]), active=S("boolean"), displayName=S("string", description="Staff display name (staff PII, needed for queue assignment UI)"))),
 # ---------- all → web
 ("audit.recorded.v1","*",["web"],"Sensitive action for the audit log (contact view, export, merge/undo, publication, exit, deal close, settings). Automatic actions use the reserved system user 00000000-0000-0000-0000-000000000001.", obj(["action","actorUserId","subjectType","subjectId"], action=S("string"), actorUserId=UUID, subjectType=S("string"), subjectId=UUID, via=S("string", enum=["ui","chat","system"]), details=S("object", additionalProperties=S("string"), description="Flat string map; MUST NOT contain PII values (IDs, codes, counts, field names only)"))),
]

def yml(o, ind=0):
    p = "  " * ind
    if isinstance(o, dict):
        if not o: return "{}"
        out = []
        for k, v in o.items():
            key = json.dumps(k) if (not k.replace("_","").replace("-","").replace(".","").replace("$","").isalnum()) else k
            if isinstance(v, (dict, list)) and v:
                out.append(f"{p}{key}:\n{yml(v, ind+1)}")
            else:
                out.append(f"{p}{key}: {yml(v, 0) if isinstance(v,(dict,list)) else json.dumps(v, ensure_ascii=False)}")
        return "\n".join(out)
    if isinstance(o, list):
        if not o: return "[]"
        out = []
        for v in o:
            if isinstance(v, dict) and v:
                s = yml(v, ind+1).lstrip()
                out.append(f"{p}- {s}")
            else:
                out.append(f"{p}- {json.dumps(v, ensure_ascii=False)}")
        return "\n".join(out)
    return json.dumps(o, ensure_ascii=False)

doc = {"asyncapi": "3.0.0",
 "info": {"title": "11 Estates CRM events", "version": "0.2.1",
   "description": "All domain events. Envelope, delivery and ordering rules: docs/04-lld/conventions.md §5. Transport: outbox → relay → pgmq queue per consumer (ADR-0003). Delivery: at least once. Ordering: per aggregate by aggregateVersion. Payloads never contain contact PII."},
 "defaultContentType": "application/json", "channels": {}, "operations": {},
 "components": {"schemas": {"Envelope": obj(["eventId","eventType","schemaVersion","occurredAt","correlationId","producer","tenantId","aggregateType","aggregateId","aggregateVersion","data"],
    eventId=UUID, eventType=S("string"), schemaVersion=S("integer"), occurredAt=DT, correlationId=S("string"), producer=S("string"), tenantId=UUID,
    aggregateType=S("string"), aggregateId=UUID, aggregateVersion=S("integer"), traceparent=S("string"), data=S("object"))}, "messages": {}}}
for name, prod, cons, desc, data in EVENTS:
    key = name.replace(".", "_")
    doc["components"]["messages"][key] = {"name": name, "title": name, "summary": desc,
        "x-producer": prod, "x-consumers": cons, "x-ordering": "per aggregate (aggregateVersion)", "x-delivery": "at-least-once; consumers dedupe on eventId",
        "payload": {"allOf": [{"$ref": "#/components/schemas/Envelope"}, {"type": "object", "properties": {"eventType": {"const": name}, "data": data}}]}}
    doc["channels"][key] = {"address": name, "messages": {key: {"$ref": f"#/components/messages/{key}"}}}
    doc["operations"][f"publish_{key}"] = {"action": "send", "channel": {"$ref": f"#/channels/{key}"}, "summary": f"Published by {prod}"}
    for c in cons:
        doc["operations"][f"{c.replace('-','_')}_consumes_{key}"] = {"action": "receive", "channel": {"$ref": f"#/channels/{key}"}, "summary": f"Consumed by {c} (queue q_{c.replace('-','_')})"}

root = pathlib.Path(__file__).resolve().parent.parent
(root / "contracts/asyncapi/events.yaml").write_text("# GENERATED by tools/gen_events.py — edit the catalogue there, then regenerate.\n" + yml(doc) + "\n")
# summary table for the Stage 4 gate
rows = ["| Event | Producer | Consumers | Meaning |", "|---|---|---|---|"] + [f"| `{n}` | {p} | {', '.join(c)} | {d} |" for n,p,c,d,_ in EVENTS]
(root / "docs/04-lld/events-table.md").write_text("# Event catalogue (generated)\n\nDelivery: at least once; ordering per aggregate; dedupe on eventId. Source: `contracts/asyncapi/events.yaml`.\n\n" + "\n".join(rows) + "\n")
print(len(EVENTS), "events")
