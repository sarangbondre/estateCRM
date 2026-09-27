// What every use case receives: ports, policy and the acting principal.
import type { StaffRoleName } from '../domain/upload.js';
import type {
  Clock,
  FileStore,
  IdGenerator,
  LocalityDirectory,
  SpreadsheetReader,
  UnitOfWork,
} from './ports.js';
import type { ReleaseSource } from './vocabulary.js';

/** Tenant policy from configuration (intake LLD §4.3, §4.9, §7; R-15, R-22). */
export interface IntakePolicy {
  /** INTAKE_PILOT_MODE: anonymise forced on, 20k-row cap, 30-day raw-row retention. */
  pilotMode: boolean;
  /** 500 pilot / 2,000 paid (INTAKE_CHUNK_SIZE). */
  chunkSize: number;
  /** Live chunk leases per tenant: 5 pilot, 12 Small, 16 Medium (R-22). */
  chunkConcurrency: number;
  /** Lease = visibility timeout: 120 s pilot, 330 s paid. */
  chunkLeaseSec: number;
  /** Max data rows per file: 20,000 pilot (CR-005), 150,000 paid. */
  maxRows: number;
  /** Raw rows kept after completion: 30 days pilot, 24 months paid (R-15). */
  rawRowRetentionDays: number;
}

export const DEFAULT_POLICY: IntakePolicy = {
  pilotMode: true,
  chunkSize: 500,
  chunkConcurrency: 5,
  chunkLeaseSec: 120,
  maxRows: 20_000,
  rawRowRetentionDays: 30,
};

/** Replaces contact values of one row with consistent fakes (pilot anonymise switch, LLD §4.9). */
export type RowAnonymiser = (cells: readonly (string | null)[]) => (string | null)[];

export interface App {
  uow: UnitOfWork;
  files: FileStore;
  sheets: SpreadsheetReader;
  clock: Clock;
  ids: IdGenerator;
  policy: IntakePolicy;
  /** Builds the anonymiser for one upload's header (tenant-keyed, deterministic). */
  anonymiser(tenantId: string, header: readonly string[]): RowAnonymiser;
  /** records micromarket hierarchy (locality normalisation). */
  localities: LocalityDirectory;
  /** records vocabulary releases; undefined when records is not configured. */
  releases: ReleaseSource | undefined;
}

export interface StaffActor {
  kind: 'staff';
  tenantId: string;
  userId: string;
  role: StaffRoleName;
  correlationId: string;
}

/** Background work (queue handlers, jobs) and service callers. */
export interface SystemActor {
  kind: 'system';
  tenantId: string;
  correlationId: string;
}

/** R-7 reserved system user. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';
