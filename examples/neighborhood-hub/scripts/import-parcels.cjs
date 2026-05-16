#!/usr/bin/env node
/**
 * Import Flint MI parcel GeoJSON into the parcels table.
 *
 * Usage:
 *   node import-parcels.js [path-to-geojson]
 *
 * Default GeoJSON path: ~/Downloads/flint_parcels_full.geojson
 * Default DB port: 15432 (from neighborhood-hub docker-compose)
 *
 * Environment variables:
 *   PGHOST     (default: localhost)
 *   PGPORT     (default: 15432)
 *   PGDATABASE (default: civic_os_db)
 *   PGUSER     (default: postgres)
 *   PGPASSWORD (default: postgres)
 *
 * Prerequisites:
 *   npm install pg    (or run from project root where pg is available)
 *
 * Copyright (C) 2023-2026 Civic OS, L3C - AGPL-3.0-or-later
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BATCH_SIZE = 500;

const CLASS_TYPE_MAP = {
  'RESIDENTIAL': 'residential',
  'COMMERCIAL': 'commercial',
  'INDUSTRIAL': 'industrial',
  'AGRICULTURAL': 'agricultural',
};

function geojsonToEWKT(geometry) {
  if (!geometry || geometry.type !== 'Polygon') return null;
  const ring = geometry.coordinates[0]; // outer ring only
  if (!ring || ring.length < 4) return null;

  const coords = ring.map(([lng, lat]) => `${lng} ${lat}`).join(', ');
  return `SRID=4326;POLYGON((${coords}))`;
}

async function main() {
  const geojsonPath = process.argv[2] || path.join(
    process.env.HOME || process.env.USERPROFILE,
    'Downloads',
    'flint_parcels_full.geojson'
  );

  if (!fs.existsSync(geojsonPath)) {
    console.error(`GeoJSON file not found: ${geojsonPath}`);
    console.error('Download from: https://data-genesee.opendata.arcgis.com/');
    process.exit(1);
  }

  console.log(`Reading GeoJSON from ${geojsonPath}...`);
  const raw = fs.readFileSync(geojsonPath, 'utf8');
  const geojson = JSON.parse(raw);
  const features = geojson.features || [];
  console.log(`Found ${features.length} features`);

  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '15432', 10),
    database: process.env.PGDATABASE || 'civic_os_db',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'securepassword123',
  });

  await client.connect();
  console.log('Connected to database');

  // Look up category IDs for property classes
  const categoryRows = await client.query(
    `SELECT id, category_key FROM metadata.categories WHERE entity_type = 'parcel_property_class'`
  );
  const categoryMap = {};
  for (const row of categoryRows.rows) {
    categoryMap[row.category_key] = row.id;
  }
  console.log('Property class categories:', Object.keys(categoryMap));

  // Truncate existing mock parcels (cascading to project_parcels)
  await client.query('DELETE FROM project_parcels');
  await client.query('DELETE FROM parcels');
  console.log('Cleared existing parcels');

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < features.length; i += BATCH_SIZE) {
    const batch = features.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const feature of batch) {
      const props = feature.properties || {};
      const ewkt = geojsonToEWKT(feature.geometry);
      if (!ewkt) {
        skipped++;
        continue;
      }

      const parcelNumber = (props.PARCELID || '').replace(/-/g, '').substring(0, 12);
      const propNum = (props.PropNum || '').substring(0, 20);
      const propDir = (props.PropDir || '').substring(0, 10);
      const propStreet = (props.PropStreet || '').substring(0, 100);
      const propCity = (props.PropCity || 'FLINT').substring(0, 50);
      const propZip = (props.PropZip || '').substring(0, 10);
      const acreage = parseFloat(props.AcreCalcTx) || null;

      // Map ClassType to category
      const classKey = CLASS_TYPE_MAP[(props.ClassType || '').toUpperCase()];
      const propertyClassId = classKey ? (categoryMap[classKey] || null) : null;

      values.push(
        `($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, ` +
        `$${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, $${paramIdx+7}, ` +
        `postgis.ST_GeogFromText($${paramIdx+8}))`
      );
      params.push(
        parcelNumber, propNum, propDir,
        propStreet, propCity, propZip, acreage,
        propertyClassId, ewkt
      );
      paramIdx += 9;
    }

    if (values.length === 0) continue;

    const sql = `INSERT INTO parcels (parcel_number, prop_num, prop_dir, prop_street, prop_city, prop_zip, acreage, property_class, boundary) VALUES ${values.join(', ')}`;
    await client.query(sql, params);
    inserted += values.length;

    if (inserted % 5000 === 0 || i + BATCH_SIZE >= features.length) {
      console.log(`Progress: ${inserted} inserted, ${skipped} skipped`);
    }
  }

  console.log(`\nDone! ${inserted} parcels inserted, ${skipped} skipped (no valid polygon)`);
  await client.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
