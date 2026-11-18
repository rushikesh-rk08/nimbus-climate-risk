# Nimbus Cement · Physical climate exposure (prototype v1)

Prototype for the Oren Product Manager assessment. It answers the question Nimbus Cement's Head of Sustainability was asked by her board, auditor and investors: *what is our business exposure to climate events today and by 2040?*

v1 covers **physical risk** only, for Nimbus's 9 plants. Transition risk (carbon pricing, CCTS) is deliberately left for v2.

Nimbus Cement and its plant data are fictional (supplied by Oren). The climate and water figures are real model outputs.

## What it shows

- **Overview:** three findings for the board: water stress, heat, and the two kiln plants the three grinding units depend on.
- **All plants:** every plant's ratings, today vs the 2040 view.
- **Plant pages:** one row per hazard, with the detail behind each rating (model spread, scenarios, sources).
- **Supply chain:** clinker flows and the revenue that depends on each kiln plant.
- **Methodology:** the source, period, scenario and threshold behind every number, plus known limitations.
- **Assumptions:** our thresholds can be changed; any change flags the whole view as non-standard.

Every figure is labelled as modelled, company data, our assumption or historical record.

## Repository layout

```
site/                 the static site Vercel serves (no build step)
  index.html          layout and styles
  app.js              views, ratings and rollups
  data.json           built by pipeline/build_data.py
  map.json            built by pipeline/build_map.py
pipeline/
  fetch_data.py       downloads Open-Meteo and WRI Aqueduct data (needs internet)
  build_data.py       turns the raw downloads into site/data.json (standard library only)
  build_map.py        India outline, Natural Earth India point of view, into site/map.json
  validate_rain_imd.py  checks each climate model's rainfall against IMD observations
data/
  nimbus_cement_plants.csv    plant file supplied by Oren
  raw/openmeteo/              18 unmodified API responses (9 plants x 2 periods, 7 models)
  raw/aqueduct/               Aqueduct 4.0 rows for the 9 plant basins
  raw/fetch_log.txt           download log with timestamps (18 Nov 2026, UTC)
  raw/imd/                    IMD observed daily rainfall 2010-2024 at the 9 plant cells, with fetch log
  validation/                 result of the IMD rain check
```

## Rebuild the data

```
python pipeline/fetch_data.py                 # optional: re-download (internet needed)
python pipeline/validate_rain_imd.py          # IMD rain check -> data/validation/
python pipeline/build_data.py                 # raw downloads -> site/data.json
python pipeline/build_map.py ne_10m_admin_0_countries_ind.geojson   # -> site/map.json
```

`build_data.py` also checks that the plant file's shipped clinker matches the supply links, and that each plant's Aqueduct state matches the plant file.

## Run locally

```
cd site && python -m http.server 8000
```

Then open http://localhost:8000.

## Key method choices

| | Choice |
|---|---|
| Periods | Today 2010–2025, 2040 view 2030–2045 (equal 16-year windows) |
| Heat | Days at or above IMD's heatwave threshold (40°C inland, 37°C coastal), median of 7 CMIP6 models. Low < 10, Medium 10–30, High > 30 days |
| Water stress | WRI Aqueduct 4.0; 2040 view uses the 2015–2045 projection, pessimistic scenario. High = Aqueduct High or Extremely high |
| Heavy rain | Shown, not rated: the model data contains physically implausible days (up to 1,248 mm; IMD's wettest observed day at these plants is 363 mm), and checked against IMD 2010–2024 no model matches at 7 of 9 plants |
| Coastal storm, river flood | Flags at the plants concerned, current exposure only |
| Supply links | A grinding unit's water rating is the worse of its own and its clinker supplier's |

Thresholds were fixed before any indicator was calculated.

## Sources and licences

- [Open-Meteo Climate API](https://open-meteo.com/en/docs/climate-api): CMIP6 data, CC BY 4.0, attribution to CMIP6 and Open-Meteo
- [WRI Aqueduct 4.0](https://www.wri.org/data/aqueduct-global-maps-40-data): Creative Commons, attribution to WRI
- [Natural Earth](https://www.naturalearthdata.com/): public domain, India point of view boundaries
- [IMD 0.25° gridded rainfall](https://www.imdpune.gov.in/cmpg/Griddata/Rainfall_25_NetCDF.html): observed rainfall used for the rain check (Pai et al. 2014)
- Cyclone records: IMD, NCRMP and press reports, linked on the Methodology page
