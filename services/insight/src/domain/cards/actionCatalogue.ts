// Proposed-action cards (R-CHAT-1, LLD §4.7, PRD §5 card table): cardType → the owning service's operation.
// insight never calls the target; the UI sends `method path payload` through web and the owner re-checks everything.
// method + path are authoritative should an owner rename an operationId.

export type SubjectKind = 'offer' | 'demand' | 'match' | 'project' | 'deal' | 'desk_item' | 'review_item';

export interface SlotDef {
  name: string;
  type: 'code' | 'enum' | 'number' | 'date' | 'datetime' | 'text' | 'phone' | 'uuid';
  /** code slots: which record kind the code must resolve to. */
  subject?: SubjectKind;
  /** enum slots: the controlled values. */
  values?: readonly string[];
  /** Key in the request payload (default: the slot name). Omitted for the path subject. */
  payloadKey?: string | null;
  required?: boolean;
}

export interface ActionDef {
  cardType: string;
  title: string;
  targetService: 'intake' | 'records' | 'journeys' | 'crm-engine' | 'listings';
  targetOperation: string;
  method: 'POST' | 'PUT' | 'PATCH';
  /** Path with `{idOrCode}` / `{id}` filled from the `pathSlot`. */
  path: string;
  pathSlot?: string;
  slots: readonly SlotDef[];
  roles: readonly string[];
  editable: readonly string[];
}

const DEMAND_MGR = ['Admin', 'Manager', 'Demand agent'] as const;
const SUPPLY_MGR = ['Admin', 'Manager', 'Supply agent'] as const;
const AGENTS = ['Admin', 'Manager', 'Demand agent', 'Supply agent'] as const;

export const ACTION_CATALOGUE: Readonly<Record<string, ActionDef>> = {
  'C-04': {
    cardType: 'C-04', title: 'Upload a file', targetService: 'intake', targetOperation: 'createUpload', method: 'POST', path: '/v1/uploads',
    slots: [{ name: 'sourceType', type: 'text' }], roles: ['Admin', 'Manager', 'Data operator'], editable: ['sourceType'],
  },
  'C-05': {
    cardType: 'C-05', title: 'Resolve a review item', targetService: 'intake', targetOperation: 'resolveReviewItem', method: 'POST',
    path: '/v1/review-items/{id}/resolve', pathSlot: 'reviewItemId',
    slots: [{ name: 'reviewItemId', type: 'uuid', payloadKey: null, required: true }, { name: 'action', type: 'enum', values: ['set', 'confirm', 'discard'] }],
    roles: ['Admin', 'Manager', 'Data operator'], editable: ['action'],
  },
  'C-06': {
    cardType: 'C-06', title: 'Quick add', targetService: 'records', targetOperation: 'quickAdd', method: 'POST', path: '/v1/quick-add',
    slots: [
      { name: 'phone', type: 'phone' },
      { name: 'side', type: 'enum', values: ['Supply', 'Demand'] },
      { name: 'dealType', type: 'enum', values: ['Sale', 'Lease', 'JV', 'Pagdi'] },
      { name: 'market', type: 'enum', values: ['Primary', 'Secondary', 'Any'] },
      { name: 'segment', type: 'enum', values: ['Residential', 'Commercial', 'Industrial', 'Land'] },
      { name: 'propertyType', type: 'text' },
      { name: 'bhk', type: 'number' },
      { name: 'areaSqft', type: 'number' },
      { name: 'budgetInr', type: 'number' },
      { name: 'locality', type: 'text' },
    ],
    roles: AGENTS, editable: ['phone', 'side', 'dealType', 'market', 'segment', 'propertyType', 'bhk', 'areaSqft', 'budgetInr', 'locality'],
  },
  'C-07': {
    cardType: 'C-07', title: 'Add supply for a demand', targetService: 'records', targetOperation: 'addSupplyForDemand', method: 'POST',
    path: '/v1/demands/{idOrCode}/add-supply', pathSlot: 'demandCode',
    slots: [{ name: 'demandCode', type: 'code', subject: 'demand', payloadKey: null, required: true }],
    roles: AGENTS, editable: [],
  },
  'C-08': {
    cardType: 'C-08', title: 'Log a call outcome', targetService: 'journeys', targetOperation: 'logCall', method: 'POST', path: '/v1/calls',
    slots: [
      { name: 'subjectCode', type: 'code', payloadKey: 'subjectCode', required: true },
      { name: 'outcome', type: 'enum', values: ['confirmed', 'no_answer', 'already_gone', 'unwilling'] },
    ],
    roles: AGENTS, editable: ['outcome'],
  },
  'C-09': {
    cardType: 'C-09', title: 'Qualify demand', targetService: 'journeys', targetOperation: 'qualifyDemand', method: 'POST',
    path: '/v1/demands/{idOrCode}/qualify', pathSlot: 'demandCode',
    slots: [{ name: 'demandCode', type: 'code', subject: 'demand', payloadKey: null, required: true }],
    roles: DEMAND_MGR, editable: [],
  },
  'C-10': {
    cardType: 'C-10', title: 'Confirm match', targetService: 'crm-engine', targetOperation: 'confirmMatch', method: 'POST',
    path: '/v1/matches/{idOrCode}/confirm', pathSlot: 'matchCode',
    slots: [{ name: 'matchCode', type: 'code', subject: 'match', payloadKey: null, required: true }],
    roles: DEMAND_MGR, editable: [],
  },
  'C-11': {
    cardType: 'C-11', title: 'Create a sourcing request', targetService: 'journeys', targetOperation: 'createSourcingRequest', method: 'POST',
    path: '/v1/sourcing-requests',
    slots: [
      { name: 'demandCode', type: 'code', subject: 'demand', payloadKey: 'demandId', required: true },
      { name: 'dueDate', type: 'date' },
      { name: 'priority', type: 'enum', values: ['low', 'normal', 'high'] },
    ],
    roles: DEMAND_MGR, editable: ['dueDate', 'priority'],
  },
  'C-12': {
    cardType: 'C-12', title: 'Set publication', targetService: 'listings', targetOperation: 'setOfferPublication', method: 'PUT',
    path: '/v1/offers/{idOrCode}/publication', pathSlot: 'offerCode',
    slots: [
      { name: 'offerCode', type: 'code', subject: 'offer', payloadKey: null, required: true },
      { name: 'level', type: 'enum', values: ['Private', 'Anonymous', 'Public'] },
    ],
    roles: SUPPLY_MGR, editable: ['level'],
  },
  'C-13': {
    cardType: 'C-13', title: 'Create a proposal', targetService: 'journeys', targetOperation: 'createProposal', method: 'POST', path: '/v1/proposals',
    slots: [{ name: 'demandCode', type: 'code', subject: 'demand', payloadKey: 'demandId', required: true }],
    roles: DEMAND_MGR, editable: [],
  },
  'C-14': {
    cardType: 'C-14', title: 'Schedule a site visit', targetService: 'journeys', targetOperation: 'scheduleSiteVisit', method: 'POST',
    path: '/v1/site-visits',
    slots: [
      { name: 'demandCode', type: 'code', subject: 'demand', payloadKey: 'demandId', required: true },
      { name: 'offerCode', type: 'code', subject: 'offer', payloadKey: 'offerId' },
      { name: 'scheduledFor', type: 'datetime' },
    ],
    roles: AGENTS, editable: ['scheduledFor'],
  },
  'C-15': {
    cardType: 'C-15', title: 'Start a deal', targetService: 'journeys', targetOperation: 'openDeal', method: 'POST', path: '/v1/deals',
    slots: [
      { name: 'demandCode', type: 'code', subject: 'demand', payloadKey: 'demandId', required: true },
      { name: 'offerCode', type: 'code', subject: 'offer', payloadKey: 'offerId', required: true },
      { name: 'followUpDate', type: 'date' },
    ],
    roles: DEMAND_MGR, editable: ['followUpDate'],
  },
  'C-16': {
    cardType: 'C-16', title: 'Exit demand', targetService: 'journeys', targetOperation: 'exitDemand', method: 'POST',
    path: '/v1/demands/{idOrCode}/exit', pathSlot: 'demandCode',
    slots: [
      { name: 'demandCode', type: 'code', subject: 'demand', payloadKey: null, required: true },
      { name: 'exit', type: 'enum', values: ['Lost', 'Dormant', 'Invalid'] },
      { name: 'revisitDate', type: 'date' },
    ],
    roles: DEMAND_MGR, editable: ['exit', 'revisitDate'],
  },
  'C-17': {
    cardType: 'C-17', title: 'Retire offer', targetService: 'journeys', targetOperation: 'retireOffer', method: 'POST',
    path: '/v1/offers/{idOrCode}/retire', pathSlot: 'offerCode',
    slots: [
      { name: 'offerCode', type: 'code', subject: 'offer', payloadKey: null, required: true },
      { name: 'reason', type: 'enum', values: ['already_gone', 'unwilling', 'other'] },
      { name: 'knownPriceInr', type: 'number' },
    ],
    roles: AGENTS, editable: ['reason', 'knownPriceInr'],
  },
  'C-18': {
    cardType: 'C-18', title: 'Add a price sheet', targetService: 'records', targetOperation: 'addPriceSheet', method: 'POST',
    path: '/v1/projects/{idOrCode}/price-sheets', pathSlot: 'projectCode',
    slots: [{ name: 'projectCode', type: 'code', subject: 'project', payloadKey: null, required: true }],
    roles: SUPPLY_MGR, editable: [],
  },
  'C-19': {
    cardType: 'C-19', title: 'Reassign queue items', targetService: 'journeys', targetOperation: 'reassignQueueItems', method: 'POST',
    path: '/v1/queue-items/reassign',
    slots: [{ name: 'toUserId', type: 'uuid' }], roles: ['Admin', 'Manager'], editable: ['toUserId'],
  },
  'C-21': {
    cardType: 'C-21', title: 'Update a desk item', targetService: 'records', targetOperation: 'patchDeskItem', method: 'PATCH',
    path: '/v1/desk-items/{idOrCode}', pathSlot: 'deskItemCode',
    slots: [
      { name: 'deskItemCode', type: 'code', subject: 'desk_item', payloadKey: null, required: true },
      { name: 'status', type: 'enum', values: ['open', 'assigned', 'archived'] },
    ],
    roles: ['Admin', 'Manager'], editable: ['status'],
  },
};
