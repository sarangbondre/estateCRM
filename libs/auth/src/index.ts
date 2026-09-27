// @11e/auth: contract-driven authentication, principals and tenant/role re-checks, service-token client (F-11).
export { authenticate } from './authenticate.js';
export type { AuthOptions } from './authenticate.js';
export { STAFF_ROLES, assertTenant, principalOf, requireStaff, tenantOf } from './principal.js';
export type {
  AnonymousPrincipal,
  Principal,
  SchedulerPrincipal,
  ServicePrincipal,
  StaffPrincipal,
  StaffRole,
  WebsitePrincipal,
} from './principal.js';
export { hashApiKey, secretsEqual } from './secrets.js';
export { createServiceTokenClient } from './token-client.js';
export type { ServiceTokenClient, ServiceTokenClientOptions } from './token-client.js';
