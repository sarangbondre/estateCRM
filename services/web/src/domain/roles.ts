// Staff roles and permission codes (PRD §2.1, §2.3; web LLD §3 `role`, §4.8). Web uses the permissions only to drive
// the UI (hiding buttons) and for its own endpoints; every service enforces the real rules for its resources.

export const ROLE_CODES = ['Admin', 'Manager', 'Demand agent', 'Supply agent', 'Data operator'] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

export const isRoleCode = (v: unknown): v is RoleCode => ROLE_CODES.includes(v as RoleCode);

/** Permission codes, one per row of the PRD §2.3 matrix. */
export const PERMISSIONS = {
  'records.view': 'View all records',
  'upload.create': 'Upload files, map templates',
  'review.work': 'Review queues (unclassified, uncertain merges, price gaps)',
  'merge.undo': 'Undo a merge',
  'demand.work': 'Quick add demand; demand journey actions',
  'supply.work': 'Add supply; supply journey actions; call outcomes',
  'supply.add_for_own_demand': 'Add supply from own demand',
  'publication.set': 'Set publication level',
  'matches.confirm': 'Confirm / reject matches, build bundles',
  'matches.suggest': 'View and suggest matches',
  'deals.work': 'Proposals, site visits, deals',
  'site_visits.work': 'Site visits and supply-side notes',
  'exits.work': 'Exits (Lost / Dormant / Invalid)',
  'offer.retire': 'Retire offer (Inactive)',
  'queue.reassign': 'Reassign owner / queue items',
  'capacity.set': 'Set call capacity',
  'dashboards.all': 'All dashboards',
  'dashboards.quality': 'Data quality dashboard',
  'chat.use': 'Chat',
  'export.create': 'Export',
  'desks.view': 'View desks (Business, Capital, Archive, Network, Watchlist)',
  'desks.work': 'Work Business / Capital desks (review, assign, archive)',
  'watchlist.close': 'Close Watchlist follow-up tasks',
  'settings.manage': 'Settings',
  'users.manage': 'Users and roles',
  'api_keys.manage': 'Listings API keys',
  'audit.read': 'Audit log',
} as const;
export type Permission = keyof typeof PERMISSIONS;

const ALL_STAFF: Permission[] = ['records.view', 'upload.create', 'chat.use', 'export.create', 'desks.view'];

const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  Admin: [
    ...ALL_STAFF,
    'review.work',
    'merge.undo',
    'demand.work',
    'supply.work',
    'publication.set',
    'matches.confirm',
    'deals.work',
    'site_visits.work',
    'exits.work',
    'offer.retire',
    'queue.reassign',
    'capacity.set',
    'dashboards.all',
    'dashboards.quality',
    'desks.work',
    'watchlist.close',
    'settings.manage',
    'users.manage',
    'api_keys.manage',
    'audit.read',
  ],
  Manager: [
    ...ALL_STAFF,
    'review.work',
    'merge.undo',
    'demand.work',
    'supply.work',
    'publication.set',
    'matches.confirm',
    'deals.work',
    'site_visits.work',
    'exits.work',
    'offer.retire',
    'queue.reassign',
    'capacity.set',
    'dashboards.all',
    'dashboards.quality',
    'desks.work',
    'watchlist.close',
  ],
  'Demand agent': [
    ...ALL_STAFF,
    'demand.work',
    'supply.add_for_own_demand',
    'matches.confirm',
    'deals.work',
    'site_visits.work',
    'exits.work',
    'dashboards.all',
    'dashboards.quality',
  ],
  'Supply agent': [
    ...ALL_STAFF,
    'supply.work',
    'publication.set',
    'matches.suggest',
    'site_visits.work',
    'offer.retire',
    'dashboards.all',
    'dashboards.quality',
    'watchlist.close',
  ],
  'Data operator': [...ALL_STAFF, 'review.work', 'dashboards.quality'],
};

const DESCRIPTIONS: Record<RoleCode, string> = {
  Admin: 'Everything, plus users, settings, reference data, API keys and the audit log',
  Manager:
    'Everything a team member can do, plus reassigning work, call capacity, undoing merges and all dashboards',
  'Demand agent': 'Works demand: quick add, qualify, match, sourcing requests, proposals, site visits, exits',
  'Supply agent': 'Works offers: call queues, contact, verify, publication levels, Add supply, projects',
  'Data operator': 'Uploads files, maps templates, works review queues',
};

/** Permissions of a user: the role's, plus the Data operator's when the flag is set on an agent (A-15). */
export function permissionsOf(role: RoleCode, isDataOperator: boolean): Permission[] {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  if (isDataOperator) for (const p of ROLE_PERMISSIONS['Data operator']) set.add(p);
  return [...set].sort();
}

export interface RoleDefinition {
  code: RoleCode;
  description: string;
  permissions: Permission[];
}

export function roleCatalogue(): RoleDefinition[] {
  return ROLE_CODES.map((code) => ({
    code,
    description: DESCRIPTIONS[code],
    permissions: [...ROLE_PERMISSIONS[code]].sort(),
  }));
}
