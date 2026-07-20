# Open geography sources for Metro Builder: Toronto

## Primary — City of Toronto Open Data ([open.toronto.ca](https://open.toronto.ca/))

| Dataset | Use |
|--------|-----|
| [Toronto Centreline (TCL)](https://open.toronto.ca/dataset/toronto-centreline-tcl/) | Shoreline + river centreline features (via City GIS FeatureServer layers 14 / 18) |
| [Ravine & Natural Feature Protection area](https://open.toronto.ca/dataset/ravine-natural-feature-protection-area/) | Ravine polygons (GIS FeatureServer layer 70) |

Licence: **Open Government Licence – Toronto**

GIS endpoints used:
- `https://gis.toronto.ca/arcgis/rest/services/cot_geospatial/FeatureServer/14` — Shoreline (includes real Toronto Islands rings)
- `https://gis.toronto.ca/arcgis/rest/services/cot_geospatial/FeatureServer/18` — River
- `https://gis.toronto.ca/arcgis/rest/services/cot_geospatial13/FeatureServer/70` — Ravine by-law areas

## Corridor supplement (Hamilton → Oshawa outside Toronto)

| Source | Use |
|--------|-----|
| OpenStreetMap — Lake Ontario multipolygon (Overpass) | Exact Lake Ontario waterbody + Hamilton Harbour connection for the full bbox |

Licence: **ODbL**

## Bbox (WGS84)

- west: **-79.95** (Hamilton)
- east: **-78.80** (Oshawa)
- south: **43.25** (Lake Ontario / Hamilton Harbour)
- north: **43.95** (inland)

Grid: **96 × 80** cells at equal metres (~966 m/cell). Aspect ratio from real east–west vs north–south span (no cartoon stretch).

## Bake

```text
node tools/bake-gta-mask.mjs
```

Outputs `gta-geo.js` (loaded by `index.html`). Island cells are **only** real Toronto Islands from the City shoreline layer — no invented islands.
