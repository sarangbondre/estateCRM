// Mapping templates (LLD §3.6): a saved column map for a header set, found again by its fingerprint.
import type { SourceType } from './upload.js';

export interface Template {
  id: string;
  tenantId: string;
  name: string;
  sourceType: SourceType;
  sourceDetail: string | null;
  headers: string[];
  headerFingerprint: string;
  columnMap: Record<string, string | null>;
  constants: Record<string, unknown> | null;
  createdBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
