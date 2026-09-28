// Projects (REC-03; price sheets REC-07, US-17): Sale/Primary developments whose configurations are offers.
import { RecordsError } from '../domain/errors.js';
import { launchAreaVerdict } from '../domain/launch-area.js';
import { possessionDateStart } from '../domain/property.js';
import { norm, uniqueStrings } from '../domain/text.js';
import type { Actor, App } from './context.js';
import { launchCitiesOf, micromarketIndexOf } from './context.js';
import { bumpOffersUpdated, emitProject } from './emit.js';
import { changedColumns, mergeEdited } from './fields.js';
import { mustFind } from './lookup.js';
import type { ProjectRow } from './model.js';
import type { Tx } from './ports.js';
import type { Dto } from './supply.js';

const PROJECT_FIELDS: [string, keyof ProjectRow][] = [
  ['name', 'name'],
  ['developerPersonId', 'developer_person_id'],
  ['developerName', 'developer_name'],
  ['locality', 'locality'],
  ['micromarketId', 'micromarket_id'],
  ['city', 'city'],
  ['state', 'state'],
  ['landmark', 'landmark'],
  ['locationText', 'location_text'],
  ['reraNumber', 'rera_number'],
  ['possessionDate', 'possession_date'],
  ['amenities', 'amenities'],
];

function mapProject(input: Dto): Partial<ProjectRow> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of PROJECT_FIELDS) {
    const v = input[k];
    if (v === undefined) continue;
    out[col] = typeof v === 'string' ? v.trim() || null : k === 'amenities' ? uniqueStrings((v as string[]) ?? []) : v;
  }
  return out as Partial<ProjectRow>;
}

async function derive(app: App, tx: Tx, p: ProjectRow, micromarketGiven: boolean): Promise<ProjectRow> {
  const tree = await micromarketIndexOf(app, tx);
  const cities = await launchCitiesOf(app, tx);
  let micromarketId = p.micromarket_id;
  if (micromarketId && !tree.byId(micromarketId)) {
    throw new RecordsError('validation-failed', 'unknown micromarket', { errors: [{ field: 'micromarketId', code: 'not-found' }] });
  }
  if (!micromarketGiven && p.locality) micromarketId = tree.resolve(p.locality)?.id ?? null;
  const node = micromarketId ? tree.byId(micromarketId) : undefined;
  if (p.developer_person_id && !(await tx.store.get('persons', p.developer_person_id))) {
    throw new RecordsError('validation-failed', 'unknown developer', { errors: [{ field: 'developerPersonId', code: 'not-found' }] });
  }
  return {
    ...p,
    name_norm: norm(p.name) ?? '',
    locality_norm: norm(p.locality),
    city_norm: norm(p.city),
    micromarket_id: micromarketId,
    outside_launch_area: launchAreaVerdict({ city: p.city, resolvedInLaunchArea: node?.in_launch_area }, cities).outside,
  };
}

async function assertUnique(tx: Tx, p: ProjectRow) {
  const same = await tx.store.find(
    'projects',
    { developer_person_id: p.developer_person_id, name_norm: p.name_norm, micromarket_id: p.micromarket_id },
    { limit: 2 },
  );
  if (same.some((x) => x.id !== p.id)) throw new RecordsError('project-exists', 'same developer, name and micromarket');
}

export async function createProject(app: App, actor: Actor, input: Dto): Promise<string> {
  return app.uow.run(actor, async (tx) => {
    const base: ProjectRow = {
      id: app.ids.next(),
      tenant_id: tx.tenantId,
      code: await tx.codes.next('PRJ', 4),
      name: '',
      name_norm: '',
      developer_person_id: null,
      developer_name: null,
      locality: null,
      locality_norm: null,
      city: null,
      city_norm: null,
      state: null,
      landmark: null,
      location_text: null,
      micromarket_id: null,
      rera_number: null,
      possession_date: null,
      amenities: [],
      floor_plan_photo_ids: [],
      latest_price_sheet_date: null,
      publication_level: 'Private',
      publication_version: 0,
      outside_launch_area: false,
      staff_edited_fields: [],
      created_at: tx.now,
      updated_at: tx.now,
      version: 1,
    };
    const row = await derive(app, tx, { ...base, ...mapProject(input) }, typeof input['micromarketId'] === 'string');
    await tx.advisoryLock(`project:${row.name_norm}`);
    await assertUnique(tx, row);
    await tx.store.insert('projects', row);
    await emitProject(tx, 'project.created.v1', row.id);
    return row.id;
  });
}

/** PATCH: facts that configuration offers carry (possession date, location) are propagated to them. */
export async function patchProject(app: App, actor: Actor, idOrCode: string, input: Dto, ifMatch: number | undefined) {
  return app.uow.run(actor, async (tx) => {
    const project = await mustFind(tx, 'projects', idOrCode, { lock: true });
    if (ifMatch !== undefined && ifMatch !== project.version) throw new RecordsError('version-mismatch');
    const mapped = mapProject(input);
    const changed = changedColumns(project as unknown as Dto, mapped as Dto);
    if (!changed.length) return project.id;
    const relocated = changed.some((c) => c === 'locality' || c === 'city' || c === 'micromarket_id');
    const next = await derive(app, tx, { ...project, ...mapped }, mapped.micromarket_id !== undefined ? mapped.micromarket_id !== null : !relocated);
    if (next.name_norm !== project.name_norm || next.micromarket_id !== project.micromarket_id || next.developer_person_id !== project.developer_person_id) {
      await assertUnique(tx, next);
    }
    const version = project.version + 1;
    await tx.store.update('projects', project.id, {
      name: next.name,
      name_norm: next.name_norm,
      developer_person_id: next.developer_person_id,
      developer_name: next.developer_name,
      locality: next.locality,
      locality_norm: next.locality_norm,
      city: next.city,
      city_norm: next.city_norm,
      state: next.state,
      landmark: next.landmark,
      location_text: next.location_text,
      micromarket_id: next.micromarket_id,
      rera_number: next.rera_number,
      possession_date: next.possession_date,
      amenities: next.amenities,
      outside_launch_area: next.outside_launch_area,
      staff_edited_fields: mergeEdited(project.staff_edited_fields, changed),
      version,
    });
    const configs = await tx.store.find('offers', { project_id: project.id, status: 'active' }, { limit: 1000 });
    if (changed.includes('possession_date')) {
      for (const o of configs.filter((c) => !c.staff_edited_fields.includes('possession_date'))) {
        await tx.store.update('offers', o.id, {
          possession_date: next.possession_date,
          possession_date_start: possessionDateStart(next.possession_date),
        });
      }
    }
    if (relocated) {
      for (const pid of new Set(configs.map((c) => c.property_id))) {
        await tx.store.update('properties', pid, {
          locality: next.locality,
          locality_norm: next.locality_norm,
          city: next.city,
          city_norm: next.city_norm,
          micromarket_id: next.micromarket_id,
          outside_launch_area: next.outside_launch_area,
        });
      }
    }
    await emitProject(tx, 'project.updated.v1', project.id);
    // Only configuration offers whose facts changed (possession date or location) get offer.updated.v1.
    if (relocated || changed.includes('possession_date')) await bumpOffersUpdated(tx, configs.map((c) => c.id));
    return project.id;
  });
}
