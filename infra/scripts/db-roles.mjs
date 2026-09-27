// Service database roles (ADR-0006). Shared by the local-stack scripts and the platform verifier.
export const SERVICES = ['web', 'intake', 'records', 'journeys', 'crm-engine', 'listings', 'insight'];
export const schemaOf = (svc) => svc.replaceAll('-', '_');

export const LOCAL_ADMIN_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const adminUrl = () => process.env.ADMIN_DATABASE_URL ?? LOCAL_ADMIN_URL;

// Local stack only: deterministic, non-secret passwords so every developer gets the same URLs. Never used in the cloud.
export const localPassword = (role) => `local_${role}`;
export const localUrl = (role) => {
  const u = new URL(LOCAL_ADMIN_URL);
  u.username = role;
  u.password = localPassword(role);
  return u.toString();
};
