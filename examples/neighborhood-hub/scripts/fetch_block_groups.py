#!/usr/bin/env python3
"""
Fetch HUD CDBG Low-to-Moderate Income block group boundaries from ArcGIS.

Queries the HUD FeatureServer with pagination, explodes MultiPolygon geometries
into separate Polygon features (one row per polygon part), and outputs clean
GeoJSON ready for import-block-groups.cjs.

Usage:
  python3 fetch_block_groups.py --output ~/Downloads/flint_block_groups.geojson
  python3 fetch_block_groups.py --bbox "-83.82,42.93,-83.60,43.10"

Prerequisites: Python 3.6+ (stdlib only, no pip installs)

Copyright (C) 2023-2026 Civic OS, L3C - AGPL-3.0-or-later
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

# HUD CDBG Low-Mod Income block group FeatureServer
HUD_URL = (
    "https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/"
    "LOW_MOD_INCOME_BY_BG/FeatureServer/0/query"
)

# Default bounding box: Flint, MI metro area
DEFAULT_BBOX = "-83.82,42.93,-83.60,43.10"

LMI_THRESHOLD = 51.0
PAGE_SIZE = 1000


def fetch_page(bbox, offset):
    """Fetch a single page of block group features from HUD ArcGIS."""
    xmin, ymin, xmax, ymax = [float(v) for v in bbox.split(",")]

    params = urllib.parse.urlencode({
        "where": "1=1",
        "geometry": json.dumps({
            "xmin": xmin, "ymin": ymin,
            "xmax": xmax, "ymax": ymax,
            "spatialReference": {"wkid": 4326}
        }),
        "geometryType": "esriGeometryEnvelope",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "GEOID,Lowmod_pct,Lowmod,Lowmoduniv,Low",
        "returnGeometry": "true",
        "f": "geojson",
        "resultOffset": offset,
        "resultRecordCount": PAGE_SIZE,
    })

    url = f"{HUD_URL}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "CivicOS-BlockGroupFetcher/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Connection error: {e.reason}", file=sys.stderr)
        sys.exit(1)


def fetch_all(bbox):
    """Fetch all pages of block group features."""
    all_features = []
    offset = 0

    while True:
        print(f"  Fetching offset {offset}...")
        data = fetch_page(bbox, offset)
        features = data.get("features", [])
        if not features:
            break
        all_features.extend(features)
        print(f"  Got {len(features)} features (total: {len(all_features)})")

        # ArcGIS indicates more pages via exceededTransferLimit
        if not data.get("properties", {}).get("exceededTransferLimit", False):
            # Also check if we got fewer than PAGE_SIZE
            if len(features) < PAGE_SIZE:
                break
        offset += PAGE_SIZE

    return all_features


def explode_multipolygons(features):
    """
    Explode MultiPolygon features into separate Polygon features.

    Each polygon part gets its own row, sharing the same GEOID and LMI properties.
    Multi-part block groups get " (Part N)" suffix on display_name.
    """
    result = []

    for feature in features:
        geom = feature.get("geometry")
        props = feature.get("properties", {})

        if not geom:
            continue

        geoid = props.get("GEOID", "")
        # HUD returns Lowmod_pct as a ratio (0.0–1.0); convert to percentage
        raw_pct = props.get("Lowmod_pct")
        lowmod_pct = round(raw_pct * 100, 2) if raw_pct is not None else None
        # HUD returns counts as comma-formatted strings (e.g. "1,065")
        def parse_int(val):
            if val is None:
                return None
            return int(str(val).replace(",", "")) if str(val).strip() else None

        lowmod = parse_int(props.get("Lowmod"))
        lowmod_universe = parse_int(props.get("Lowmoduniv"))
        low = parse_int(props.get("Low"))
        is_lmi = (lowmod_pct or 0) >= LMI_THRESHOLD

        base_name = f"Block Group {geoid}" if geoid else "Unknown Block Group"

        clean_props = {
            "display_name": base_name,
            "geoid": geoid,
            "lowmod_pct": lowmod_pct,
            "lowmod": lowmod,
            "lowmod_universe": lowmod_universe,
            "low": low,
            "is_lmi": is_lmi,
        }

        if geom["type"] == "Polygon":
            result.append({
                "type": "Feature",
                "geometry": geom,
                "properties": clean_props,
            })
        elif geom["type"] == "MultiPolygon":
            parts = geom["coordinates"]
            for i, polygon_coords in enumerate(parts):
                part_props = dict(clean_props)
                if len(parts) > 1:
                    part_props["display_name"] = f"{base_name} (Part {i + 1})"

                result.append({
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": polygon_coords},
                    "properties": part_props,
                })
        else:
            print(f"  Skipping unsupported geometry type: {geom['type']}", file=sys.stderr)

    return result


def main():
    parser = argparse.ArgumentParser(description="Fetch HUD block group LMI boundaries")
    parser.add_argument(
        "--bbox", default=DEFAULT_BBOX,
        help=f"Bounding box as xmin,ymin,xmax,ymax (default: {DEFAULT_BBOX})"
    )
    parser.add_argument(
        "--output", default=None,
        help="Output GeoJSON path (default: ~/Downloads/flint_block_groups.geojson)"
    )
    args = parser.parse_args()

    import os
    output_path = args.output or os.path.join(
        os.environ.get("HOME", os.environ.get("USERPROFILE", ".")),
        "Downloads", "flint_block_groups.geojson"
    )

    print(f"Fetching HUD block groups for bbox: {args.bbox}")
    raw_features = fetch_all(args.bbox)
    print(f"\nFetched {len(raw_features)} raw features from HUD")

    # Explode MultiPolygon → Polygon
    features = explode_multipolygons(raw_features)
    print(f"Exploded to {len(features)} polygon features")

    # Summary
    lmi_count = sum(1 for f in features if f["properties"]["is_lmi"])
    non_lmi = len(features) - lmi_count
    print(f"\nLMI Qualified: {lmi_count}")
    print(f"Not LMI:       {non_lmi}")

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w") as f:
        json.dump(geojson, f)

    print(f"\nWrote {len(features)} features to {output_path}")


if __name__ == "__main__":
    main()
