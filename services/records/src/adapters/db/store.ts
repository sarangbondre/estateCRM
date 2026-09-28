// Tenant-scoped row access (application Store port) on one Kysely transaction. Every statement filters on
// tenant_id (conventions §3, NFR-15); table names come from the typed port, never from user input.
import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { Tables } from '../../application/model.js';
import type { CodedTable, FindOptions, IdTable, NewRow, Store, TableName } from '../../application/ports.js';
import { JSONB_COLUMNS, TOUCHED_TABLES } from './schema.js';
import type { RecordsDb } from './schema.js';

type Loose = Kysely<Record<string, Record<string, unknown>>>;
// Table and column names are dynamic here (typed at the port); builders are handled untyped inside this adapter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;
const MAX_ROWS = 1000;

export function serialise(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const json = JSONB_COLUMNS[table];
  if (!json) return row;
  const out = { ...row };
  for (const col of json) {
    if (col in out) out[col] = out[col] === undefined ? undefined : JSON.stringify(out[col] ?? null);
  }
  return out;
}

export class KyselyStore implements Store {
  readonly #db: Loose;
  readonly #tenantId: string;

  constructor(trx: Transaction<RecordsDb> | Kysely<RecordsDb>, tenantId: string) {
    this.#db = trx as unknown as Loose;
    this.#tenantId = tenantId;
  }

  #where(qb: AnyBuilder, table: string, where: Record<string, unknown>): AnyBuilder {
    let q = qb.where(`${table}.tenant_id`, '=', this.#tenantId);
    for (const [col, val] of Object.entries(where)) {
      if (val === undefined) continue;
      q = val === null ? q.where(`${table}.${col}`, 'is', null) : q.where(`${table}.${col}`, '=', val);
    }
    return q;
  }

  async insert<T extends TableName>(table: T, rows: NewRow<T> | readonly NewRow<T>[]): Promise<void> {
    const list = (Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[];
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 500) {
      await this.#db
        .insertInto(table)
        .values(list.slice(i, i + 500).map((r) => serialise(table, { ...r, tenant_id: this.#tenantId })))
        .execute();
    }
  }

  async insertIgnore<T extends TableName>(table: T, row: NewRow<T>): Promise<boolean> {
    const r = await this.#db
      .insertInto(table)
      .values(serialise(table, { ...(row as Record<string, unknown>), tenant_id: this.#tenantId }))
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    return Number(r.numInsertedOrUpdatedRows ?? 0) > 0;
  }

  async update<T extends IdTable>(table: T, id: string, patch: Partial<Tables[T]>): Promise<void> {
    await this.updateWhere(table, { id } as Partial<Tables[T]>, patch);
  }

  async updateWhere<T extends TableName>(
    table: T,
    where: Partial<Tables[T]>,
    patch: Partial<Tables[T]>,
  ): Promise<number> {
    const set = serialise(table, { ...(patch as Record<string, unknown>) });
    for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
    if (TOUCHED_TABLES.has(table) && !('updated_at' in set)) set['updated_at'] = sql`now()`;
    if (!Object.keys(set).length) return 0;
    const r = await this.#where((this.#db.updateTable(table) as AnyBuilder).set(set), table, where as Record<string, unknown>).executeTakeFirst();
    return Number(r.numUpdatedRows ?? 0);
  }

  async get<T extends IdTable>(table: T, id: string, options: { lock?: boolean } = {}): Promise<Tables[T] | undefined> {
    const [row] = await this.find(table, { id } as Partial<Tables[T]>, { limit: 1, ...(options.lock ? { lock: true } : {}) });
    return row;
  }

  async getMany<T extends IdTable>(table: T, ids: readonly string[]): Promise<Tables[T][]> {
    return this.findIn(table, 'id' as keyof Tables[T] & string, ids);
  }

  async getByCode<T extends CodedTable>(
    table: T,
    code: string,
    options: { lock?: boolean } = {},
  ): Promise<Tables[T] | undefined> {
    const [row] = await this.find(table, { code } as unknown as Partial<Tables[T]>, {
      limit: 1,
      ...(options.lock ? { lock: true } : {}),
    });
    return row;
  }

  async find<T extends TableName>(
    table: T,
    where: Partial<Tables[T]>,
    options: FindOptions<T> = {},
  ): Promise<Tables[T][]> {
    let q = this.#where(this.#db.selectFrom(table).selectAll(), table, where as Record<string, unknown>);
    for (const o of options.orderBy ?? []) q = q.orderBy(`${table}.${o.column}`, o.direction ?? 'asc');
    q = q.limit(Math.min(options.limit ?? MAX_ROWS, MAX_ROWS));
    if (options.lock) q = q.forUpdate();
    return (await q.execute()) as Tables[T][];
  }

  async findIn<T extends TableName, C extends keyof Tables[T] & string>(
    table: T,
    column: C,
    values: readonly unknown[],
    where: Partial<Tables[T]> = {},
  ): Promise<Tables[T][]> {
    const distinct = [...new Set(values)].filter((v) => v !== null && v !== undefined);
    if (!distinct.length) return [];
    const out: Tables[T][] = [];
    for (let i = 0; i < distinct.length; i += MAX_ROWS) {
      const chunk = distinct.slice(i, i + MAX_ROWS);
      const q = this.#where(this.#db.selectFrom(table).selectAll(), table, where as Record<string, unknown>)
        .where(`${table}.${column}`, 'in', chunk)
        .limit(MAX_ROWS * 5);
      out.push(...((await q.execute()) as Tables[T][]));
    }
    return out;
  }

  async delete<T extends TableName>(table: T, where: Partial<Tables[T]>): Promise<number> {
    const r = await this.#where(this.#db.deleteFrom(table), table, where as Record<string, unknown>).executeTakeFirst();
    return Number(r.numDeletedRows ?? 0);
  }

  async scan<T extends IdTable>(
    table: T,
    afterId: string | null,
    limit: number,
    where: Partial<Tables[T]> = {},
  ): Promise<Tables[T][]> {
    let q = this.#where(this.#db.selectFrom(table).selectAll(), table, where as Record<string, unknown>);
    if (afterId) q = q.where(`${table}.id`, '>', afterId);
    return (await q.orderBy(`${table}.id`).limit(Math.min(limit, MAX_ROWS)).execute()) as Tables[T][];
  }

  async count<T extends TableName>(table: T, where: Partial<Tables[T]>): Promise<number> {
    const r = await this.#where(
      (this.#db.selectFrom(table) as AnyBuilder).select(sql<string>`count(*)`.as('n')),
      table,
      where as Record<string, unknown>,
    ).executeTakeFirst();
    return Number((r as { n?: string } | undefined)?.n ?? 0);
  }
}
