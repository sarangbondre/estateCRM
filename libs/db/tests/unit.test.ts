import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ConnectionAcquireTimeoutError, RoleCapAwarePool } from '../src/pool.js';
import { classifyDbError } from '../src/errors.js';
import { InvalidTenantError, assertTenantId } from '../src/tenant.js';
import { lintMigration } from '../src/migrate.js';
import { hashRequest } from '../src/idempotency.js';

const capError = () => Object.assign(new Error('too many connections for role'), { code: '53300' });
const fakePool = (connect: () => Promise<unknown>) =>
  ({
    connect,
    end: async () => {},
    options: {},
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  }) as unknown as pg.Pool;

describe('RoleCapAwarePool', () => {
  it('retries role-cap rejections until a connection is free', async () => {
    let calls = 0;
    const pool = new RoleCapAwarePool(
      fakePool(async () => {
        calls++;
        if (calls < 3) throw capError();
        return { release: () => {} };
      }),
      2000,
    );
    await expect(pool.connect()).resolves.toBeDefined();
    expect(calls).toBe(3);
  });

  it('gives up at the deadline with ConnectionAcquireTimeoutError', async () => {
    const pool = new RoleCapAwarePool(
      fakePool(async () => {
        throw capError();
      }),
      120,
    );
    await expect(pool.connect()).rejects.toBeInstanceOf(ConnectionAcquireTimeoutError);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    const pool = new RoleCapAwarePool(
      fakePool(async () => {
        calls++;
        throw Object.assign(new Error('password authentication failed'), { code: '28P01' });
      }),
      2000,
    );
    await expect(pool.connect()).rejects.toThrow('password authentication failed');
    expect(calls).toBe(1);
  });
});

describe('classifyDbError', () => {
  it.each([
    ['23505', 'unique-violation', false],
    ['40001', 'serialization-failure', true],
    ['40P01', 'deadlock', true],
    ['57014', 'statement-timeout', false],
    ['53300', 'too-many-connections', true],
    ['XX000', 'unknown', false],
  ])('%s → %s', (code, kind, retryable) => {
    expect(classifyDbError({ code })).toMatchObject({ kind, retryable, code });
  });
  it('keeps the constraint name and handles non-errors', () => {
    expect(classifyDbError({ code: '23505', constraint: 'offers_pk' }).constraint).toBe('offers_pk');
    expect(classifyDbError(null)).toEqual({ kind: 'unknown', retryable: false });
  });
});

describe('assertTenantId', () => {
  it('accepts a UUID and rejects anything else', () => {
    expect(() => assertTenantId('00000000-0000-4000-8000-000000000001')).not.toThrow();
    for (const bad of ['', 'tenant-a', "x' or 1=1 --", 42, undefined]) {
      expect(() => assertTenantId(bad)).toThrow(InvalidTenantError);
    }
  });
});

describe('lintMigration', () => {
  it('allows additive changes', () => {
    expect(
      lintMigration(
        'create table t (id int); alter table t add column name text; create index i on t (name);',
      ),
    ).toEqual([]);
  });
  it.each([
    ['alter table t drop column name;', 'DROP'],
    ['drop table t;', 'DROP'],
    ['alter table t rename column a to b;', 'RENAME'],
    ['alter table t alter column a type bigint;', 'ALTER COLUMN TYPE'],
    ['alter table t alter column a set not null;', 'SET NOT NULL'],
    ['truncate t;', 'TRUNCATE'],
  ])('flags %s', (sqlText, what) => {
    expect(lintMigration(sqlText).join()).toContain(what);
  });
  it('ignores destructive words in comments, and allows a declared contract step', () => {
    expect(lintMigration('-- we used to drop table t here\ncreate table u (id int);')).toEqual([]);
    expect(
      lintMigration(
        '-- contract: name moved to display_name in 0007, readers switched in 0008\nalter table t drop column name;',
      ),
    ).toEqual([]);
  });
});

describe('hashRequest', () => {
  it('is stable across key order and differs by content', () => {
    expect(hashRequest({ a: 1, b: { c: [1, 2], d: 'x' } })).toBe(
      hashRequest({ b: { d: 'x', c: [1, 2] }, a: 1 }),
    );
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
    expect(hashRequest(undefined)).toBe(hashRequest(null));
  });
});
