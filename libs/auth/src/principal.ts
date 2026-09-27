// Who is calling (conventions §4 auth rows, web LLD §4.2). Services re-check role and tenant for their own resources.
import type { ServiceContext } from '@11e/http';
import { forbidden, notFound, unauthenticated } from '@11e/http';

export const STAFF_ROLES = ['Admin', 'Manager', 'Demand agent', 'Supply agent', 'Data operator'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffPrincipal {
  kind: 'staff';
  tenantId: string;
  userId: string;
  role: StaffRole;
  tokenId: string;
  /** Extra claim `dop` from web, passed through unchanged. */
  dop?: unknown;
}
export interface ServicePrincipal {
  kind: 'service';
  /** Calling service, e.g. `listings`. */
  caller: string;
  tenantId: string;
  tokenId: string;
}
export interface SchedulerPrincipal {
  kind: 'scheduler';
}
export interface WebsitePrincipal {
  kind: 'website';
  tenantId: string;
  keyId: string;
}
export interface AnonymousPrincipal {
  kind: 'anonymous';
}
export type Principal =
  StaffPrincipal | ServicePrincipal | SchedulerPrincipal | WebsitePrincipal | AnonymousPrincipal;

export function principalOf(c: ServiceContext): Principal {
  const p = c.get('principal') as Principal | undefined;
  if (!p) throw unauthenticated();
  return p;
}

export function requireStaff(c: ServiceContext, roles?: readonly StaffRole[]): StaffPrincipal {
  const p = principalOf(c);
  if (p.kind !== 'staff') throw forbidden('staff only');
  if (roles && !roles.includes(p.role)) throw forbidden(`role ${p.role} is not allowed`);
  return p;
}

/** Tenant of any tenant-bound caller (staff, service, website). */
export function tenantOf(c: ServiceContext): string {
  const p = principalOf(c);
  if (p.kind === 'staff' || p.kind === 'service' || p.kind === 'website') return p.tenantId;
  throw forbidden('no tenant for this caller');
}

/**
 * Resource-level re-check: a resource of another tenant is reported as not found, so its existence doesn't leak.
 */
export function assertTenant(c: ServiceContext, resourceTenantId: string): void {
  if (tenantOf(c) !== resourceTenantId) throw notFound();
}
