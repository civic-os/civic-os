/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Golden outputs: SchemaService interpretation of the raw metadata fixtures,
 * for every example x role (+ pothole es). See golden-io.ts and
 * tests/golden/derived/frontend/COVERAGE.md.
 */
import { firstValueFrom } from 'rxjs';
import { SchemaService } from '../../services/schema.service';
import { isStaticText, SchemaEntityProperty } from '../../interfaces/entity';
import { checkGolden, expectNoOrphans, loadRaw, Variant } from './golden-io';
import { listGoldenVariants } from './synthetic-fixtures';
import { flushAll, loadSchema, typeName } from './schema-harness';
import { fingerprint, validatorSignature } from './validator-fingerprint';

const col = (props: SchemaEntityProperty[]) => props.map(p => p.column_name);

async function propertiesArtifact(v: Variant) {
  const { service, httpMock, tables, props } = await loadSchema(v);
  const byEntity: Record<string, unknown[]> = {};
  for (const p of props) {
    const select = SchemaService.propertyToSelectString(p);
    const edit = SchemaService.propertyToSelectStringForEdit(p);
    const list = SchemaService.propertyToSelectStringForList(p);
    (byEntity[p.table_name] ??= []).push({
      column: p.column_name,
      type: typeName(p.type),
      typeId: p.type,
      select,
      selectForEdit: edit === select ? '=' : edit,
      selectForList: list === select ? '=' : list,
      columnSpan: SchemaService.getColumnSpan(p),
      defaultValue: SchemaService.getDefaultValueForProperty(p),
    });
  }

  // getPropertiesForEntityFresh skips M:M enrichment but runs the same getPropertyType.
  const fresh: Record<string, string[]> = {};
  for (const t of tables) {
    const p$ = firstValueFrom(service.getPropertiesForEntityFresh(t));
    flushAll(httpMock, 'schema_properties', loadRaw(v, 'schema_properties'));
    fresh[t.table_name] = (await p$).map(p => `${p.column_name}:${typeName(p.type)}`);
  }
  return { entities: byEntity, freshTypes: fresh };
}

describe('golden: SchemaService interpretation', () => {
  for (const v of listGoldenVariants()) {
    it(`${v.example}/${v.variant}: properties, selects, spans, defaults`, async () => {
      checkGolden(`${v.example}/${v.variant}/schema.properties.json`, await propertiesArtifact(v));
    });

    it(`${v.example}/${v.variant}: view property lists and renderables`, async () => {
      const { service, tables } = await loadSchema(v);
      const entities: Record<string, unknown> = {};
      for (const t of tables) {
        const [list, detail, create, edit, filter, dR, cR, eR] = await Promise.all([
          firstValueFrom(service.getPropsForList(t)),
          firstValueFrom(service.getPropsForDetail(t)),
          firstValueFrom(service.getPropsForCreate(t)),
          firstValueFrom(service.getPropsForEdit(t)),
          firstValueFrom(service.getPropsForFilter(t)),
          firstValueFrom(service.getDetailRenderables(t)),
          firstValueFrom(service.getCreateRenderables(t)),
          firstValueFrom(service.getEditRenderables(t)),
        ]);
        const plan = (items: any[]) => items.map(i =>
          isStaticText(i)
            ? { kind: 'static_text', id: i.id, sortOrder: i.sort_order, span: SchemaService.getRenderableColumnSpan(i) }
            : { kind: 'property', column: i.column_name, span: SchemaService.getRenderableColumnSpan(i) });
        entities[t.table_name] = {
          list: col(list), detail: col(detail), create: col(create), edit: col(edit), filter: col(filter),
          renderables: { detail: plan(dR), create: plan(cR), edit: plan(eR) },
        };
      }
      checkGolden(`${v.example}/${v.variant}/schema.views.json`, { entities });
    });

    it(`${v.example}/${v.variant}: junctions, M:M enrichment, parent hops`, async () => {
      const { service, tables, props } = await loadSchema(v);
      const junctionTables = [...(await firstValueFrom(service.getDetectedJunctionTables()))].sort();
      const virtualProperties = props.filter(p => p.many_to_many_meta);
      const relationships: Record<string, unknown> = {};
      for (const t of tables) {
        const metas = await firstValueFrom(service.getManyToManyRelationships(t.table_name));
        if (metas.length) relationships[t.table_name] = metas;
      }
      checkGolden(`${v.example}/${v.variant}/schema.m2m.json`, { junctionTables, virtualProperties, relationships });
    });

    it(`${v.example}/${v.variant}: inverse relationships and menus`, async () => {
      const { service, tables } = await loadSchema(v);
      const inverse: Record<string, unknown> = {};
      for (const t of tables) {
        const rels = await firstValueFrom(service.getInverseRelationships(t.table_name));
        const excluded = rels.length ? new Set([rels[0].sourceTable]) : new Set<string>();
        const withExclude = await firstValueFrom(service.getInverseRelationships(t.table_name, excluded));
        inverse[t.table_name] = { all: rels, excluding: [...excluded], afterExclude: withExclude.map(r => r.sourceTable) };
      }
      const menu = await firstValueFrom(service.getEntitiesForMenu());
      const mgmt = await firstValueFrom(service.getEntitiesForManagement());
      checkGolden(`${v.example}/${v.variant}/schema.inverse-menu.json`, {
        inverse,
        menu: menu.map(t => t.table_name),
        management: mgmt.map(t => t.table_name),
      });
    });

    it(`${v.example}/${v.variant}: validator fingerprints`, async () => {
      const { props } = await loadSchema(v);
      const signatureOf: Record<string, string> = {};
      const signatures: Record<string, unknown> = {};
      for (const p of props) {
        const sig = validatorSignature(p);
        signatureOf[`${p.table_name}.${p.column_name}`] = sig;
        if (!(sig in signatures)) signatures[sig] = fingerprint(p);
      }
      checkGolden(`${v.example}/${v.variant}/schema.validators.json`, { signatureOf, signatures });
    });
  }

  it('no orphan schema.* golden files', () => {
    expectNoOrphans(rel => /\/schema\.[a-z-]+\.json$/.test(rel));
  });
});
