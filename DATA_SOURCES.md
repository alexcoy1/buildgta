# Open geography sources for Metro Builder: Toronto

## Primary — City of Toronto Open Data ([open.toronto.ca](https://open.toronto.ca/))

| Dataset | Use |
|--------|-----|
| [Toronto Centreline (TCL)](https://open.toronto.ca/dataset/toronto-centreline-tcl/) | Shoreline + river centreline features (via City GIS FeatureServer layers 14 / 18) |
| [Ravine & Natural Feature Protection area](https://open.toronto.ca/dataset/ravine-natural-feature-protection-area/) | Reference only — rivers used as thin ravine strokes (not unbuildable flood fill) |

Licence: **Open Government Licence – Toronto**

## Corridor supplement

| Source | Use |
|--------|-----|
| OpenStreetMap — Lake Ontario multipolygon (Overpass) | Lake Ontario waterbody |
| OpenStreetMap — `highway=motorway` ref~401 | Highway 401 corridor spine |

Licence: **ODbL**

## Bbox (WGS84) — land-first framing

- west: **-79.95** (Hamilton)
- east: **-78.80** (Oshawa / Clarington)
- south: **~43.26** (harbour lip; deep lake beyond ~2.4 km coastal band is off-map void)
- north: **44.10** (York Region / Newmarket)

Grid: SimCity lot scale (~96 m/cell), true aspect. Bake with:

```text
node tools/bake-gta-mask.mjs
```

Outputs `gta-geo.js` + `data/gta-mask.json`. Island cells are **only** real Toronto Islands — no invented islands.
