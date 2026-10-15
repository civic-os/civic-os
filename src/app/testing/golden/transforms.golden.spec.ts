/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs: the two page-level transformValuesForApi copies
 * (CreatePage, EditPage) and EditPage.transformValueForControl, over synthetic
 * rows per entity and a DST-edge matrix, captured under a TZ matrix.
 *
 * The page methods are private and read only `this.currentProps`, so the REAL
 * implementation is invoked from the class prototype with a stand-in `this`
 * (no component instantiation).
 */
import { firstValueFrom } from 'rxjs';
import { CreatePage } from '../../pages/create/create.page';
import { EditPage } from '../../pages/edit/edit.page';
import { EntityPropertyType, SchemaEntityProperty } from '../../interfaces/entity';
import { createMockProperty } from '../mock-schema';
import { acrossZones, checkGolden, expectNoOrphans, stableStringify, TIME_ZONES, withTimeZone } from './golden-io';
import { listGoldenVariants } from './synthetic-fixtures';
import { loadSchema, typeName } from './schema-harness';

const createApi = (props: SchemaEntityProperty[], form: any) =>
  (CreatePage.prototype as any).transformValuesForApi.call({ currentProps: props }, form);
const editApi = (props: SchemaEntityProperty[], form: any) =>
  (EditPage.prototype as any).transformValuesForApi.call({ currentProps: props }, form);
const editControl = (prop: SchemaEntityProperty, raw: any) =>
  (EditPage.prototype as any).transformValueForControl.call({}, prop, raw);

const FILE_UUID = '11111111-1111-4111-8111-111111111111';
const GALLERY_UUID = '22222222-2222-4222-8222-222222222222';
const USER_UUID = '33333333-3333-4333-8333-333333333333';

type RowKind = 'typical' | 'empty' | 'odd';

/** Form-control values as the page would hand to transformValuesForApi. */
function formValue(p: SchemaEntityProperty, kind: RowKind): unknown {
  if (kind === 'empty') return p.type === EntityPropertyType.Boolean ? null : (p.column_name.length % 2 ? '' : null);
  const odd = kind === 'odd';
  switch (p.type) {
    case EntityPropertyType.DateTime: return odd ? '2026-07-04T10:30:15' : '2026-07-04T10:30';
    case EntityPropertyType.DateTimeLocal: return odd ? 'abcdefghijklmnop' : '2026-07-04T17:30';
    case EntityPropertyType.Date: return '2026-07-04';
    case EntityPropertyType.Money: return odd ? '$1,234.50' : 1234.5;
    case EntityPropertyType.IntegerNumber: return 7;
    case EntityPropertyType.DecimalNumber: return 1.5;
    case EntityPropertyType.Boolean: return !odd;
    case EntityPropertyType.File:
    case EntityPropertyType.FileImage:
    case EntityPropertyType.FilePDF:
      return odd ? FILE_UUID : { id: FILE_UUID, file_name: 'f.pdf', file_type: 'application/pdf' };
    case EntityPropertyType.PhotoGallery:
      return odd ? GALLERY_UUID : { id: GALLERY_UUID, photo_gallery_files: [] };
    case EntityPropertyType.ForeignKeyName:
    case EntityPropertyType.Status:
    case EntityPropertyType.Category:
      return odd ? { id: 3, display_name: 'x' } : 3;
    case EntityPropertyType.User: return USER_UUID;
    case EntityPropertyType.TimeSlot:
    case EntityPropertyType.RecurringTimeSlot: return '[2026-07-04T15:00:00Z,2026-07-04T22:00:00Z)';
    case EntityPropertyType.GeoPoint: return 'SRID=4326;POINT(-83 43)';
    case EntityPropertyType.GeoPolygon: return 'SRID=4326;POLYGON((0 0,1 0,1 1,0 0))';
    default: return odd ? 42 : 'text';
  }
}

/** Raw row values as PostgREST returns them to transformValueForControl. */
function rawValue(p: SchemaEntityProperty, kind: RowKind): unknown {
  if (kind === 'empty') return p.column_name.length % 2 ? null : undefined;
  const odd = kind === 'odd';
  switch (p.type) {
    case EntityPropertyType.DateTime: return odd ? '2026-07-04T10:30:00.123456' : '2026-07-04T10:30:00';
    case EntityPropertyType.DateTimeLocal: return odd ? 'garbage' : '2026-07-04T17:30:00+00:00';
    case EntityPropertyType.Money: return odd ? 'abc' : '$1,234.50';
    default: return formValue(p, 'typical');
  }
}

function auditKeys(kind: RowKind): Record<string, unknown> {
  return kind === 'typical'
    ? { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', extra_key: 'kept' }
    : {};
}

/** M:M properties are in currentProps but excluded from the FormGroup, so their keys never reach the transforms. */
const inCreateForm = (p: SchemaEntityProperty) => p.type !== EntityPropertyType.ManyToMany;
/** edit.page.ts builds controls (and calls transformValueForControl) only for show_on_edit !== false and non-M:M. */
const inEditForm = (p: SchemaEntityProperty) => p.show_on_edit !== false && p.type !== EntityPropertyType.ManyToMany;

const pageProps = {
  create: (props: SchemaEntityProperty[]) => props.filter(p =>
    (p.type !== EntityPropertyType.ManyToMany || p.show_inline === true) &&
    p.type !== EntityPropertyType.File && p.type !== EntityPropertyType.FileImage && p.type !== EntityPropertyType.FilePDF),
  edit: (props: SchemaEntityProperty[]) => props.filter(p =>
    p.type !== EntityPropertyType.ManyToMany || p.show_inline === true),
};

// Golden characterization runs real interpretation code over every raw fixture
// and large input/time-zone matrices: it is CPU-bound by design, so it gets an
// explicit budget instead of vitest's 5 s default (which CPU starvation exceeds).
describe('golden: page transforms', { timeout: 60_000 }, () => {
  it('process.env.TZ switches the zone in-process and is restored', () => {
    const offsetJan = () => new Date(2026, 0, 15, 12).getTimezoneOffset();
    const before = offsetJan();
    expect(withTimeZone('UTC', offsetJan)).toBe(0);
    expect(withTimeZone('America/New_York', offsetJan)).toBe(300);
    expect(withTimeZone('Asia/Kolkata', offsetJan)).toBe(-330);
    expect(withTimeZone('Australia/Lord_Howe', offsetJan)).toBe(-660);
    // half-hour DST: Lord Howe is +10:30 in winter (July) and +11 in summer
    expect(withTimeZone('Australia/Lord_Howe', () => new Date(2026, 6, 15, 12).getTimezoneOffset())).toBe(-630);
    expect(offsetJan()).toBe(before);
  });

  for (const v of listGoldenVariants()) {
    it(`${v.example}/${v.variant}: synthetic rows per entity`, async () => {
      const { service, tables } = await loadSchema(v);
      const entities: Record<string, unknown> = {};
      for (const t of tables) {
        const createProps = pageProps.create(await firstValueFrom(service.getPropsForCreate(t)));
        const editProps = pageProps.edit(await firstValueFrom(service.getPropsForEdit(t)));
        const rows: Record<string, unknown> = {};
        for (const kind of ['typical', 'empty', 'odd'] as RowKind[]) {
          const createForm: Record<string, unknown> = { ...auditKeys(kind) };
          for (const p of createProps.filter(inCreateForm)) createForm[p.column_name] = formValue(p, kind);
          const editForm: Record<string, unknown> = { ...auditKeys(kind) };
          for (const p of editProps.filter(inEditForm)) editForm[p.column_name] = formValue(p, kind);
          const raw: Record<string, unknown> = {};
          for (const p of editProps.filter(inEditForm)) raw[p.column_name] = rawValue(p, kind);

          rows[kind] = {
            createFormInput: createForm,
            editFormInput: editForm,
            rawRow: raw,
            outputs: acrossZones(() => ({
              createApi: createApi(createProps, createForm),
              editApi: editApi(editProps, editForm),
              control: Object.fromEntries(editProps.filter(inEditForm).map(p => [p.column_name, editControl(p, raw[p.column_name])])),
            })),
          };
        }
        entities[t.table_name] = {
          createProps: createProps.map(p => `${p.column_name}:${typeName(p.type)}`),
          editProps: editProps.map(p => `${p.column_name}:${typeName(p.type)}`),
          rows,
        };
      }
      checkGolden(`${v.example}/${v.variant}/transforms.rows.json`, { entities });
    });
  }

  it('DST-edge and malformed-value matrix under the TZ matrix', () => {
    const mk = (column_name: string, type: EntityPropertyType) => createMockProperty({ column_name, type });
    const props = [
      mk('dt', EntityPropertyType.DateTime),
      mk('dtl', EntityPropertyType.DateTimeLocal),
      mk('amount', EntityPropertyType.Money),
      mk('doc', EntityPropertyType.File),
      mk('img', EntityPropertyType.FileImage),
      mk('pdf', EntityPropertyType.FilePDF),
      mk('gallery', EntityPropertyType.PhotoGallery),
      mk('when', EntityPropertyType.Date),
    ];
    const formEdges = [
      '2026-03-08T01:59', '2026-03-08T02:30', '2026-03-08T03:00',          // America/New_York spring-forward gap
      '2026-11-01T00:59', '2026-11-01T01:30', '2026-11-01T02:00',          // America/New_York fall-back overlap
      '2026-04-05T01:45', '2026-04-05T02:15',                              // Lord_Howe 30-minute fall-back overlap
      '2026-10-04T01:45', '2026-10-04T02:15', '2026-10-04T02:45',          // Lord_Howe 30-minute spring-forward gap
      '2026-12-31T23:59', '2026-01-01T00:00', '2024-02-29T12:00', '1969-12-31T23:59',
      '2026-02-30T10:00', '2026-13-01T10:00', '2026-07-04T24:00', 'abcdefghijklmnop',
      '2026-07-04T10:30:00', '2026-07-04T10:30:15', '2026-07-04T10:30Z', '',
    ];
    const rawEdges = [
      '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-03-08T07:30:00Z',
      '2026-11-01T05:30:00+00:00', '2026-11-01T06:30:00Z',
      '2026-04-04T14:45:00Z', '2026-04-04T15:15:00Z',
      '2026-10-03T15:45:00Z', '2026-10-03T16:15:00Z', '2026-10-03T16:45:00Z',
      '2026-07-04T17:30:00.000Z', '2026-07-04T17:30:00+05:30', '2026-12-31T23:59:59Z',
      '2026-07-04T17:30:00', '2026-07-04', 'garbage', '', 0, 1783186200000,
    ];
    const valueShapes: unknown[] = [null, undefined, 0, 1, true, {}, [], { id: '' }, { id: 0 }, { id: FILE_UUID }, FILE_UUID, 'x'];
    const moneyRaw = ['$1,234.50', '$0.00', '-$5.25', '(1.00)', '€10.00', '1234.5', '', 'abc', '$1,2,3', 5, null];

    const result: Record<string, unknown> = {};
    for (const tz of TIME_ZONES) {
      result[tz] = withTimeZone(tz, () => {
        const api: Record<string, unknown> = {};
        for (const e of formEdges) {
          const form = { dt: e, dtl: e };
          api[e] = { create: createApi(props, form), edit: editApi(props, form) };
        }
        const control: Record<string, unknown> = {};
        for (const e of rawEdges) {
          control[String(e)] = { dt: editControl(props[0], e), dtl: editControl(props[1], e) };
        }
        const money: Record<string, unknown> = {};
        for (const m of moneyRaw) money[String(m)] = editControl(props[2], m);
        const shapes: Record<string, unknown> = {};
        valueShapes.forEach((s, i) => {
          const form = { doc: s, img: s, pdf: s, gallery: s, amount: s, when: s };
          shapes[`${i}:${stableStringify(s).trim()}`] = { create: createApi(props, form), edit: editApi(props, form) };
        });
        return { api, control, money, shapes };
      });
    }
    checkGolden('_shared/transforms.dst-edges.json', { formEdges, rawEdges, zones: result });
  });

  it('no orphan transforms.* golden files', () => {
    expectNoOrphans(rel => /\/transforms\.[a-z-]+\.json$/.test(rel));
  });
});
