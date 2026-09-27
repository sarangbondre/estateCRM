// Kysely types of the web schema (migrations 0001–0002).
import type { ColumnType, IdempotencyKeysTable } from '@11e/db';
import type { JobLeasesTable } from '@11e/http';
import type { OutboxDb } from '@11e/outbox';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;

export interface UsersTable {
  tenant_id: string;
  id: string;
  email: string;
  email_hash: Buffer;
  display_name: string;
  role: string;
  is_data_operator: boolean;
  status: string;
  invited_by: string | null;
  invited_at: TsNull;
  activated_at: TsNull;
  deactivated_at: TsNull;
  last_seen_at: TsNull;
  version: number;
  created_at: Ts;
  updated_at: Ts;
}

export interface InvitationTable {
  tenant_id: string;
  id: string;
  user_id: string;
  email_hash: Buffer;
  role: string;
  is_data_operator: boolean;
  status: string;
  invited_by: string;
  expires_at: Ts;
  accepted_at: TsNull;
  created_at: Ts;
  updated_at: Ts;
}

export interface AuditLogTable {
  tenant_id: string;
  id: string;
  event_id: string | null;
  occurred_at: Ts;
  recorded_at: Ts;
  producer: string;
  action: string;
  actor_user_id: string;
  subject_type: string;
  subject_id: string;
  via: string;
  details: ColumnType<Record<string, string>, string, string>;
  correlation_id: string | null;
  prev_hash: Buffer;
  entry_hash: Buffer;
}

export interface NotificationTable {
  tenant_id: string;
  id: string;
  user_id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  subject_code: string | null;
  title: string;
  link: string;
  source_event_id: string | null;
  read_at: TsNull;
  created_at: Ts;
  updated_at: Ts;
}

export interface RateLimitBucketTable {
  tenant_id: string;
  subject_key: string;
  bucket: string;
  tokens: ColumnType<string, number | string, number | string>;
  refilled_at: Ts;
}

export interface ChatStreamLeaseTable {
  tenant_id: string;
  user_id: string;
  lease_id: string;
  expires_at: Ts;
}

export interface ServiceClientTable {
  tenant_id: ColumnType<string, string | undefined, string>;
  name: string;
  credential_hash: Buffer;
  allowed_audiences: string[];
  status: ColumnType<string, string | undefined, string>;
  rotated_at: Ts;
  created_at: Ts;
  updated_at: Ts;
}

export interface SigningKeyTable {
  tenant_id: ColumnType<string, string | undefined, string>;
  kid: string;
  alg: ColumnType<string, string | undefined, string>;
  public_jwk: ColumnType<Record<string, unknown>, string, string>;
  private_key_enc: Buffer;
  status: string;
  activated_at: Ts;
  retire_after: TsNull;
  created_at: Ts;
  updated_at: Ts;
}

export interface RoleTable {
  tenant_id: string;
  code: string;
  description: string;
  permissions: string[];
}

export interface WebDb extends OutboxDb {
  users: UsersTable;
  invitation: InvitationTable;
  audit_log: AuditLogTable;
  notification: NotificationTable;
  rate_limit_bucket: RateLimitBucketTable;
  chat_stream_lease: ChatStreamLeaseTable;
  service_client: ServiceClientTable;
  signing_key: SigningKeyTable;
  role: RoleTable;
  idempotency_keys: IdempotencyKeysTable;
  job_leases: JobLeasesTable;
  schema_migrations: { version: string; name: string; checksum: string; applied_at: Date };
}
