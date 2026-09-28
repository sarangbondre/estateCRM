// What the use cases get from the composition root: ports only (CLAUDE.md §3.1).
import type { CeilingPolicy } from '../domain/ceiling.js';
import type {
  Clock,
  MicromarketReader,
  PhotoSource,
  PhotoStore,
  Random,
  ScanTermsReader,
  TermHasher,
  UnitOfWork,
  ImageProcessor,
} from './ports.js';

export interface Services {
  uow: UnitOfWork;
  clock: Clock;
  random: Random;
  policy: CeilingPolicy;
  /** SHA-256 hex of a string (payload hashes, scanned text hashes). */
  sha256: (text: string) => string;
  termHasher: TermHasher;
  /** Public CDN URL of a public photo path. */
  publicPhotoUrl: (publicPath: string) => string;
  scanTerms?: ScanTermsReader | undefined;
  micromarkets?: MicromarketReader | undefined;
  photoSource?: PhotoSource | undefined;
  photoStore?: PhotoStore | undefined;
  images?: ImageProcessor | undefined;
}

/** Application errors: adapters map them to RFC 7807 problems (LLD §6). */
export class AppError extends Error {
  override readonly name = 'AppError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
    readonly errors?: { field: string; code: string; message?: string }[],
  ) {
    super(detail ?? code);
  }
}

export const notFound = (what: string) => new AppError(404, 'not-found', `${what} not found`);
