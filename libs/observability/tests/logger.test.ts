// The key F-12 requirement: phone numbers, e-mail addresses and names never reach log output (conventions §7,
// implementation rules §2.4), however they are passed in.
import { describe, expect, it } from 'vitest';
import { ALLOWED_LOG_FIELDS, createLogger, scrubText } from '../src/index.js';
import type { Logger, LoggerOptions } from '../src/index.js';

function capture(options: Partial<LoggerOptions> = {}): {
  log: Logger;
  lines: () => Record<string, unknown>[];
  raw: () => string;
} {
  const out: string[] = [];
  const log = createLogger({
    service: 'records',
    level: 'trace',
    destination: { write: (s) => void out.push(s) },
    ...options,
  });
  return {
    log,
    raw: () => out.join(''),
    lines: () => out.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

// Indian phone numbers in the formats people actually type (mobile and landline), plus e-mails and names.
const PHONES = [
  '9876543210',
  '+91 98765 43210',
  '+91-98765-43210',
  '+919876543210',
  '+91.98765.43210',
  '0091 98765 43210',
  '09876543210',
  '098765-43210',
  '91 9876543210',
  '91-9876543210',
  '(+91) 98765-43210',
  '+91 (987) 654-3210',
  '98765 43210',
  '98765-43210',
  '987-654-3210',
  '98 76 54 32 10',
  '022-2345 6789',
  '(022) 23456789',
  '022 23456789',
  '080-4123-4567',
];
const EMAILS = [
  'ramesh.kumar@example.com',
  'RAMESH+crm@gmail.co.in',
  'a_b-c@sub.domain.in',
  'priya @ example . com',
];
const NAMES = ['Ramesh Kumar', 'Priya Sharma', 'Anil'];

/** The digits of every phone, so a number can't slip through re-formatted (e.g. separators dropped). */
const PHONE_DIGITS = ['9876543210', '23456789', '41234567'];

function assertClean(raw: string) {
  for (const p of PHONES) expect(raw).not.toContain(p);
  for (const e of EMAILS) expect(raw).not.toContain(e);
  expect(raw).not.toContain('@');
  for (const n of NAMES) expect(raw).not.toContain(n);
  for (const line of raw.trim().split('\n')) {
    const values: string[] = [];
    JSON.parse(line, (k, v: unknown) => {
      if (k !== 'ts' && (typeof v === 'string' || typeof v === 'number')) values.push(String(v));
      return v;
    });
    for (const v of values) {
      const digits = v.replace(/\D/g, '');
      for (const d of PHONE_DIGITS) expect(digits, `value ${v}`).not.toContain(d);
    }
  }
}

describe('PII never reaches log output', () => {
  it.each(PHONES.map((p) => [p]))('phone %s in every position', (phone) => {
    const { log, raw } = capture();
    const email = EMAILS[0] ?? '';
    log.info(
      { phone, mobile: phone, contact: { phone, email }, phones: [phone], note: `call ${phone}` },
      `call ${phone}`,
    );
    log.info(`lead ${phone} / ${email}`);
    log.warn({ code: phone, route: phone, eventType: phone, queue: phone, tenantId: phone, userId: phone });
    log.warn({
      correlationId: phone.replace(/\D/g, ''),
      msgId: phone.replace(/\D/g, ''),
      msgIdNum: Number(phone.replace(/\D/g, '')),
    });
    log.warn({
      msgId: Number(phone.replace(/\D/g, '')),
      count: Number(phone.replace(/\D/g, '')),
      status: Number(phone.replace(/\D/g, '')),
    });
    log.error(new Error(`no demand for ${phone}`));
    log.error({ err: new Error(`duplicate phone ${phone}\n    at ${phone}`) }, 'save failed');
    log
      .child({ phone, tenantId: phone, correlationId: phone.replace(/\D/g, '') })
      .info({ durationMs: 5 }, 'done');
    assertClean(raw());
  });

  it.each(EMAILS.map((e) => [e]))('e-mail %s in every position', (email) => {
    const { log, raw } = capture();
    log.info({ email, owner: { email }, emails: [email] }, `mail ${email}`);
    log.warn({ code: email, route: email, userId: email, errorName: email, downstream: email });
    const err = new Error(`bounce ${email}`) as Error & { code: string };
    err.code = email;
    log.error(err, `bounced ${email}`);
    log.child({ email, userId: email }).info('child');
    assertClean(raw());
  });

  it('drops names in arbitrary fields, nested objects, arrays, error names and error causes', () => {
    const { log, raw } = capture();
    log.info({ name: 'Ramesh Kumar', customer: { name: 'Priya Sharma', address: { line1: 'Anil' } } });
    log.info({ names: ['Ramesh Kumar', 'Priya Sharma'], details: new Error('Anil') });
    log.info({ code: 'Ramesh Kumar', eventType: 'Priya Sharma', outcome: 'Ramesh Kumar' });
    const err = new Error('for Ramesh Kumar', { cause: new Error('Priya Sharma 9876543210') });
    err.name = 'Priya Sharma';
    log.error({ err, errors: [err] });
    assertClean(raw());
  });

  it('drops non-primitive and unusual values', () => {
    const { log, lines } = capture();
    log.info({
      tenantId: { toString: () => '9876543210' },
      count: 9876543210n,
      status: '200',
      durationMs: -1,
      attempt: 1.5,
      route: () => '/v1/x',
      eventType: Symbol('x'),
      __proto__: { code: 'inherited' },
    } as unknown as Record<string, unknown>);
    const [line] = lines();
    expect(Object.keys(line ?? {}).sort()).toEqual(['level', 'msg', 'service', 'ts']);
  });

  it('keeps the message out of stack traces and only keeps it via the redaction hook, still scrubbed', () => {
    const plain = capture();
    const err = new Error('lookup failed for 9876543210');
    plain.log.error({ err }, 'handler failed');
    const [line] = plain.lines();
    const safe = line?.['err'] as { name: string; message?: string; stack?: string };
    expect(safe.name).toBe('Error');
    expect(safe.message).toBeUndefined();
    expect(safe.stack).toMatch(/^at /);
    expect(safe.stack).not.toContain('lookup failed');
    expect(safe.stack?.split('\n')[0]).toMatch(/^at .*\btests\/logger\.test\.ts:\d+:\d+\)?$/);
    expect(line?.['msg']).toBe('handler failed');

    const hooked = capture({ redactMessage: (t) => t.replace('lookup', '[verb]') });
    hooked.log.error(err);
    const [h] = hooked.lines();
    expect((h?.['err'] as { message: string }).message).toBe('[verb] failed for [redacted]');
    expect(h?.['msg']).toBe('');
    assertClean(plain.raw() + hooked.raw());
  });
});

describe('allow-listed fields', () => {
  const tenantId = '0190a5d8-7c3e-7b4a-9d1e-123456789012';
  const correlationId = '0190a5d8-7c3e-7b4a-9d1e-2f3a4b5c6d7e';

  it('writes ts, level, service and the allowed fields unchanged', () => {
    const { log, lines } = capture();
    log.info(
      {
        correlationId,
        tenantId,
        userId: '0190a5d8-7c3e-7b4a-9d1e-aaaaaaaaaaaa',
        route: '/v1/offers/{idOrCode}',
        method: 'GET',
        operationId: 'getOffer',
        status: 200,
        durationMs: 12,
        eventType: 'offer.created.v1',
        queue: 'q_records',
        msgId: '123456789',
        attempt: 2,
        code: 'not-found',
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: '00f067aa0ba902b7',
        unknown: 'dropped',
      },
      'request',
    );
    const [line] = lines();
    expect(line).toMatchObject({
      level: 'info',
      service: 'records',
      correlationId,
      tenantId,
      route: '/v1/offers/{idOrCode}',
      status: 200,
      durationMs: 12,
      eventType: 'offer.created.v1',
      msgId: '123456789',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      msg: 'request',
    });
    expect(line?.['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(line).not.toHaveProperty('unknown');
    expect(line).not.toHaveProperty('pid');
    expect(line).not.toHaveProperty('hostname');
    expect(line).not.toHaveProperty('time');
  });

  it('reduces errors to name, stable code and stack frames', () => {
    const { log, lines } = capture();
    class DownstreamTimeout extends Error {
      override name = 'DownstreamTimeout';
      code = 'dependency-unavailable';
    }
    log.error({
      err: new DownstreamTimeout('records timed out for ramesh@example.com'),
      route: '/v1/demands',
    });
    const [line] = lines();
    expect(line?.['err']).toMatchObject({ name: 'DownstreamTimeout', code: 'dependency-unavailable' });
    expect(Object.keys(line?.['err'] as object).sort()).toEqual(['code', 'name', 'stack']);
  });

  it('binds request fields on child loggers, and nested children keep them', () => {
    const { log, lines } = capture();
    const req = log.child({
      correlationId,
      tenantId,
      userId: tenantId,
      route: '/v1/offers',
      phone: '9876543210',
    });
    req.info({ status: 201 }, 'created');
    req.child({ operationId: 'createOffer' }).warn('slow');
    log.info('no bindings');
    const [a, b, c] = lines();
    expect(a).toMatchObject({ correlationId, tenantId, userId: tenantId, route: '/v1/offers', status: 201 });
    expect(a).not.toHaveProperty('phone');
    expect(b).toMatchObject({
      correlationId,
      tenantId,
      route: '/v1/offers',
      operationId: 'createOffer',
      level: 'warn',
    });
    expect(c).not.toHaveProperty('correlationId');
  });

  it('respects the level', () => {
    const { log, lines } = capture({ level: 'warn' });
    log.info('hidden');
    log.warn('shown');
    expect(lines().map((l) => l['msg'])).toEqual(['shown']);
    expect(log.isLevelEnabled('info')).toBe(false);
  });

  it('allow-list is the reviewed set (adding a field needs a code review of fields.ts)', () => {
    expect(Object.keys(ALLOWED_LOG_FIELDS).sort()).toMatchInlineSnapshot(`
      [
        "attempt",
        "code",
        "correlationId",
        "count",
        "deadLettered",
        "downstream",
        "duplicates",
        "durationMs",
        "errorName",
        "eventId",
        "eventType",
        "failed",
        "lagSeconds",
        "method",
        "msgId",
        "operationId",
        "outcome",
        "processed",
        "queue",
        "remaining",
        "route",
        "service",
        "spanId",
        "status",
        "tenantId",
        "traceId",
        "unroutable",
        "userId",
      ]
    `);
  });

  it('scrubText leaves ordinary text alone', () => {
    expect(scrubText('offer OFF-000123 moved to Captured in 45 ms')).toBe(
      'offer OFF-000123 moved to Captured in 45 ms',
    );
    expect(scrubText('call 98765 43210 or mail a@b.in')).toBe('call [redacted] or mail [redacted]');
  });
});
