#!/usr/bin/env node
/**
 * Import census block group GeoJSON into the census_block_groups table.
 *
 * Usage:
 *   node import-block-groups.cjs [path-to-geojson]
 *
 * Default GeoJSON path: ~/Downloads/flint_block_groups.geojson
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
    'flint_block_groups.geojson'
  );

  if (!fs.existsSync(geojsonPath)) {
    console.error(`GeoJSON file not found: ${geojsonPath}`);
    console.error('Run fetch_block_groups.py first to download HUD data.');
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

  // Look up LMI status category IDs
  const categoryRows = await client.query(
    `SELECT id, category_key FROM metadata.categories WHERE entity_type = 'lmi_status'`
  );
  const categoryMap = {};
  for (const row of categoryRows.rows) {
    categoryMap[row.category_key] = row.id;
  }
  console.log('LMI status categories:', categoryMap);

  if (!categoryMap['lmi_qualified'] || !categoryMap['not_lmi']) {
    console.error('Missing lmi_status categories. Ensure init scripts have run.');
    process.exit(1);
  }

  // Clear existing data
  await client.query('DELETE FROM census_block_groups');
  console.log('Cleared existing census block groups');

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

      const displayName = (props.display_name || 'Unknown Block Group').substring(0, 255);
      const geoid = (props.geoid || '').substring(0, 12) || null;
      const lowmodPct = props.lowmod_pct != null ? props.lowmod_pct : null;
      const lowmod = props.lowmod != null ? props.lowmod : null;
      const lowmodUniverse = props.lowmod_universe != null ? props.lowmod_universe : null;
      const low = props.low != null ? props.low : null;

      // Map is_lmi boolean to category FK
      const lmiStatusId = props.is_lmi
        ? categoryMap['lmi_qualified']
        : categoryMap['not_lmi'];

      values.push(
        `($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, ` +
        `$${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, ` +
        `postgis.ST_GeogFromText($${paramIdx+7}))`
      );
      params.push(
        displayName, geoid, lowmodPct, lowmod,
        lowmodUniverse, low, lmiStatusId, ewkt
      );
      paramIdx += 8;
    }

    if (values.length === 0) continue;

    const sql = `INSERT INTO census_block_groups (display_name, geoid, lowmod_pct, lowmod, lowmod_universe, low, lmi_status, boundary) VALUES ${values.join(', ')}`;
    await client.query(sql, params);
    inserted += values.length;

    if (inserted % 500 === 0 || i + BATCH_SIZE >= features.length) {
      console.log(`Progress: ${inserted} inserted, ${skipped} skipped`);
    }
  }

  // Final summary
  const countResult = await client.query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE lmi_status = $1) as lmi_count,
      COUNT(*) FILTER (WHERE lmi_status = $2) as non_lmi_count
    FROM census_block_groups
  `, [categoryMap['lmi_qualified'], categoryMap['not_lmi']]);

  const stats = countResult.rows[0];
  console.log(`\nDone! ${inserted} block groups inserted, ${skipped} skipped (no valid polygon)`);
  console.log(`  LMI Qualified: ${stats.lmi_count}`);
  console.log(`  Not LMI:       ${stats.non_lmi_count}`);
  console.log(`  Total:         ${stats.total}`);

  await client.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
