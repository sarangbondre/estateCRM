// UnitOfWork on Kysely: repositories bound to a transaction, the transactional outbox (libs/outbox writeEvent) and
// pgmq work queues written in the same transaction as the state change (CLAUDE.md §3.4).
import { withTransaction } from '@11e/db';
import type { Kysely, Transaction } from '@11e/db';
import { queueSend, writeEvent } from '@11e/outbox';
import type { EventType } from '@11e/outbox';
import type { NewEvent, Repositories, Tx, UnitOfWork } from '../application/ports.js';
import { SCHEMA, SERVICE } from '../config.js';
import type { IntakeDb } from './db.js';
import { migrationMapRepository, rowErrorRepository } from './repositories/reports.js';
import { chunkRepository, fingerprintRepository, rawRowRepository } from './repositories/processing.js';
import { templateRepository, vocabularyRepository } from './repositories/templates.js';
import { uploadRepository } from './repositories/uploads.js';

type Db = Kysely<IntakeDb> | Transaction<IntakeDb>;

export function repositories(db: Db): Repositories {
  return {
    uploads: uploadRepository(db),
    chunks: chunkRepository(db),
    fingerprints: fingerprintRepository(db),
    rawRows: rawRowRepository(db),
    rowErrors: rowErrorRepository(db),
    migration: migrationMapRepository(db),
    templates: templateRepository(db),
    vocabulary: vocabularyRepository(db),
  };
}

export function txContext(trx: Transaction<IntakeDb>): Tx {
  return {
    repos: repositories(trx),
    events: {
      async emit<T extends EventType>(e: NewEvent<T>) {
        await writeEvent(trx, { ...e, producer: SERVICE });
      },
    },
    queue: {
      async send(queue, payload, delaySec = 0) {
        await queueSend(trx, SCHEMA, queue, payload, delaySec);
      },
    },
  };
}

export function unitOfWork(db: Kysely<IntakeDb>): UnitOfWork {
  return {
    repos: repositories(db),
    transaction(fn, options = {}) {
      return withTransaction(db, (trx) => fn(txContext(trx)), {
        statementTimeoutMs: options.timeoutMs ?? 2000,
      });
    },
  };
}
