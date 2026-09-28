// Synthetic E2E users, one per role (no real personal data).
import { fileURLToPath } from 'node:url';
import type { RoleCode } from '../src/domain/roles';

export const E2E_USERS = {
  admin: { email: 'e2e.admin@example.com', name: 'Asha Admin', role: 'Admin' },
  manager: { email: 'e2e.manager@example.com', name: 'Mira Manager', role: 'Manager' },
  demand: { email: 'e2e.demand@example.com', name: 'Priya Demand', role: 'Demand agent' },
  supply: { email: 'e2e.supply@example.com', name: 'Vikram Supply', role: 'Supply agent' },
  operator: { email: 'e2e.operator@example.com', name: 'Omkar Operator', role: 'Data operator' },
} as const satisfies Record<string, { email: string; name: string; role: RoleCode }>;

export type E2eRole = keyof typeof E2E_USERS;

export const authFile = (role: string) => fileURLToPath(new URL(`./.auth/${role}.json`, import.meta.url));
