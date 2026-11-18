"""
Build site/data.json from the raw downloads. Standard library only.

    python pipeline/build_data.py

Inputs (all in data/):
  nimbus_cement_plants.csv                  plant file supplied by Oren (fictional company)
  raw/openmeteo/P0x_{today|future}_*.json   Open-Meteo Climate API, 7 CMIP6 models, unmodified
  raw/aqueduct/*baseline_annual.csv         WRI Aqueduct 4.0 rows for the 9 plant basins
  raw/aqueduct/*future_annual.csv           WRI Aqueduct 4.0 projections for the same basins
  raw/fetch_log.txt                         download log (retrieval times)

Nothing here is tuned to the results: thresholds and rules were fixed before the
indicators were calculated (see site Methodology page).
"""

import csv
import json
import statistics as st
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "site" / "data.json"

MODELS = ["CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S",
          "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S"]
HEAT_THRESHOLD = {"inland": 40.0, "coastal": 37.0}   # IMD heatwave consideration thresholds
HEAVY_RAIN_MM = 64.5                                  # IMD "heavy rainfall" lower bound
IMPLAUSIBLE_MM = 300.0                                # flag for data-quality check only
PERIODS = {"today": "2010-2025", "future": "2030-2045"}

# Clinker links as stated in the plant file's notes / clinker_shipped column
SUPPLY = [("P01", "P07", 1.12), ("P06", "P08", 0.68), ("P06", "P09", 0.60)]

# Aqueduct water stress: raw ratio -> Aqueduct's five categories
def aq_category(raw):
    if raw is None:
        return None
    if raw < 0.1:
        return "Low"
    if raw < 0.2:
        return "Low-medium"
    if raw < 0.4:
        return "Medium-high"
    if raw < 0.8:
        return "High"
    return "Extremely high"


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def read_csv(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def tidy_label(s):
    return " ".join(s.replace(" - ", "-").split()) if s else s


def ensemble(values):
    return {"median": round(st.median(values), 1), "min": round(min(values), 1), "max": round(max(values), 1)}


def climate_block(pid, coastal):
    basis = "coastal" if coastal else "inland"
    thr = HEAT_THRESHOLD[basis]
    out = {"heat": {"threshold_c": thr, "basis": basis}, "rain": {}}
    per_model = {}
    for label, years in PERIODS.items():
        d = json.loads((DATA / "raw" / "openmeteo" / f"{pid}_{label}_{years}.json").read_text())["daily"]
        n_years = len({t[:4] for t in d["time"]})
        pm = {}
        for m in MODELS:
            tx = d[f"temperature_2m_max_{m}"]
            pr = d[f"precipitation_sum_{m}"]
            by_year = {}
            for t, x in zip(d["time"], pr):
                by_year[t[:4]] = max(by_year.get(t[:4], 0.0), x)
            pm[m] = {
                "hot_days": sum(1 for x in tx if x >= thr) / n_years,
                "heavy_days": sum(1 for x in pr if x >= HEAVY_RAIN_MM) / n_years,
                "wettest_day_mm": st.median(by_year.values()),
                "annual_mm": sum(pr) / n_years,
                "implausible_days": sum(1 for x in pr if x >= IMPLAUSIBLE_MM),
                "max_day_mm": max(pr),
            }
        per_model[label] = pm
    for key, dest, field in [("hot_days", "heat", "days"), ("heavy_days", "rain", "heavy_days"),
                             ("wettest_day_mm", "rain", "wettest_day_mm"), ("annual_mm", "rain", "annual_mm")]:
        block = {}
        for label in PERIODS:
            block[label] = ensemble([per_model[label][m][key] for m in MODELS])
            block[label]["by_model"] = {m: round(per_model[label][m][key], 1) for m in MODELS}
        up = sum(per_model["future"][m][key] > per_model["today"][m][key] for m in MODELS)
        down = sum(per_model["future"][m][key] < per_model["today"][m][key] for m in MODELS)
        block["models_up"], block["models_down"] = up, down
        out[dest][field] = block
    out["rain"]["implausible_days"] = sum(per_model[p][m]["implausible_days"] for p in PERIODS for m in MODELS)
    out["rain"]["max_day_mm"] = round(max(per_model[p][m]["max_day_mm"] for p in PERIODS for m in MODELS))
    out["rain"]["rated"] = False
    return out


def water_block(pid, base, fut):
    b, f = base[pid], fut[pid]
    future = {}
    for scen, name in [("opt", "Optimistic (SSP1-2.6)"), ("bau", "Business as usual (SSP3-7.0)"),
                       ("pes", "Pessimistic (SSP5-8.5)")]:
        future[scen] = {"name": name}
        for yr, period in [("30", "2015-2045"), ("50", "2035-2065")]:
            raw = num(f[f"{scen}{yr}_ws_x_r"])
            future[scen]["p20" + yr] = {"period": period, "raw": round(raw, 3), "category": aq_category(raw)}
    raw = num(b["bws_raw"])
    return {
        "basin_id": int(float(b["pfaf_id"])),
        "aqueduct_state": b["name_1"],
        "baseline": {"period": "1979-2019", "raw": round(raw, 3), "category": aq_category(raw),
                     "aqueduct_label": tidy_label(b["bws_label"])},
        "future": future,
        "groundwater_trend": tidy_label(b["gtd_label"]),
        "drought_risk": tidy_label(b["drr_label"]),
        "riverine_flood": tidy_label(b["rfr_label"]),
        "coastal_flood": tidy_label(b["cfr_label"]),
    }


FLAG_SOURCES = {
    "moes_cyclone_list": {"short": "IMD cyclone-prone list (MoES, 2015)",
                          "title": "MoES reply to Lok Sabha Q251 (22 Jul 2015): cyclone-prone districts, Annexure I",
                          "url": "https://moes.gov.in/sites/default/files/LS_251_English_22_07_2015.pdf"},
    "ncrmp_1999": {"short": "NCRMP cyclone history",
                   "title": "National Cyclone Risk Mitigation Project: cyclone history of Odisha",
                   "url": "https://www.ncrmp.gov.in/?p=6750"},
    "ht_atlas": {"short": "IMD hazard atlas (via Hindustan Times, 2022)",
                 "title": "Hindustan Times (19 Jan 2022) on IMD's Climate Hazards and Vulnerability Atlas",
                 "url": "https://www.pressreader.com/india/hindustan-times-east-up/20220119/281741272791191"},
    "dte_biparjoy": {"short": "Down To Earth (2023)",
                     "title": "Down To Earth (Jun 2023): Mundra port operations suspended for Cyclone Biparjoy",
                     "url": "https://www.downtoearth.org.in/amp/story/natural-disasters/dte-ground-report-gujarat-s-coast-from-kutch-to-bhavnagar-gears-up-to-withstand-biporjoy-landfall-89997"},
    "unb_biparjoy": {"short": "AP via UNB (2023)",
                     "title": "UNB/AP (Jun 2023): winds threw shipping containers into the sea at Mundra",
                     "url": "https://unb.com.bd/news/tag/122800"},
}

REFERENCES = [
    {"key": "openmeteo", "title": "Open-Meteo Climate API documentation (models, downscaling, bias correction)", "url": "https://open-meteo.com/en/docs/climate-api"},
    {"key": "aqueduct", "title": "WRI Aqueduct 4.0 data download", "url": "https://www.wri.org/data/aqueduct-global-maps-40-data"},
    {"key": "aqueduct_note", "title": "Kuzma et al. (2023), Aqueduct 4.0 technical note", "url": "https://doi.org/10.46830/writn.23.00061"},
    {"key": "ipcc", "title": "IPCC AR6 WGI Chapter 4: near-term projections across scenarios", "url": "https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-4/"},
    {"key": "imd_heat", "title": "IMD heat bulletin: heatwave criteria (40°C plains, 37°C coastal)", "url": "https://mausam.imd.gov.in/pdfs/heatcolduser/morning_heat_bulletin.pdf"},
    {"key": "imd_rain", "title": "MoES reply to Rajya Sabha (Jul 2023): IMD rainfall categories", "url": "https://www.moes.gov.in/sites/default/files/RS-in-25-27-07-2023.pdf"},
    {"key": "imd_grid", "title": "IMD 0.25° gridded rainfall (for the planned validation)", "url": "https://www.imdpune.gov.in/cmpg/Griddata/Rainfall_25_NetCDF.html"},
    {"key": "natural_earth", "title": "Natural Earth admin-0 countries, India point of view", "url": "https://www.naturalearthdata.com/"},
]


def flags_for(pid, water):
    flags = []
    if pid == "P07":
        flags.append({
            "type": "coastal_storm", "title": "Coastal storm: current exposure",
            "points": [
                "Kachchh district sees recurring severe cyclones every 4 to 10 years (IMD Climate Hazards and Vulnerability Atlas, as reported).",
                "Cyclone Biparjoy, June 2023: landfall near Jakhau, about 100 km away. Mundra port operations were suspended and containers were blown into the sea.",
                f"WRI Aqueduct coastal flood risk: {water['coastal_flood']}.",
            ],
            "sources": ["ht_atlas", "dte_biparjoy", "unb_biparjoy"],
        })
    if pid == "P08":
        flags.append({
            "type": "coastal_storm", "title": "Coastal storm: current exposure",
            "points": [
                "Jagatsinghpur district is classed 'very highly prone' to cyclones, one of 12 such districts in India (IMD classification).",
                "1999 Super Cyclone made landfall near Paradip, with winds of 260 km/h and a 6 to 7 m storm surge.",
                f"WRI Aqueduct coastal flood risk: {water['coastal_flood']}.",
            ],
            "sources": ["moes_cyclone_list", "ncrmp_1999"],
        })
    if water["riverine_flood"].startswith("High"):
        flags.append({
            "type": "river_flood", "title": "River flood: current exposure",
            "points": [f"WRI Aqueduct riverine flood risk is {water['riverine_flood'].split(' (')[0]}: about {water['riverine_flood'].split('(')[1].rstrip(')')} people affected by river flooding in an average year."],
            "sources": ["aqueduct"],
        })
    return flags


def retrieval_window():
    lines = (DATA / "raw" / "fetch_log.txt").read_text(encoding="utf-8").splitlines()
    times = [l[1:9] for l in lines if l.startswith("[") and ("saved" in l or "Download complete" in l)]
    return {"date": "2026-11-18", "first_utc": min(times), "last_utc": max(times)}


def main():
    plants_csv = read_csv(DATA / "nimbus_cement_plants.csv")
    base = {r["plant_id"]: r for r in read_csv(next((DATA / "raw" / "aqueduct").glob("*baseline_annual.csv")))}
    fut = {r["plant_id"]: r for r in read_csv(next((DATA / "raw" / "aqueduct").glob("*future_annual.csv")))}

    plants = []
    for r in plants_csv:
        pid = r["plant_id"]
        coastal = r["coastal"].strip().upper() == "Y"
        water = water_block(pid, base, fut)
        if water["aqueduct_state"] != r["state"]:
            raise SystemExit(f"{pid}: Aqueduct state {water['aqueduct_state']} != file state {r['state']}")
        p = {
            "id": pid,
            "name": r["plant_name"],
            "short": r["town"],
            "town": r["town"], "state": r["state"],
            "lat": float(r["latitude"]), "lon": float(r["longitude"]),
            "type": r["plant_type"],
            "coastal": coastal,
            "capacity_mtpa": float(r["cement_capacity_mtpa"]),
            "cement_output_mt": float(r["cement_output_fy2025_26_mt"]),
            "clinker_produced_mt": float(r["clinker_produced_fy2025_26_mt"]),
            "scope1_kt": float(r["scope1_co2_fy2025_26_kt"]),
            "water_source": r["water_source"],
            "asset_cr": float(r["asset_value_inr_cr"]),
            "revenue_cr": float(r["revenue_fy2025_26_inr_cr"]),
            "employees": int(r["employees"]),
            "notes": r["notes"].strip(),
            "receives_from": [{"id": s, "mt": mt} for s, d, mt in SUPPLY if d == pid],
            "supplies_to": [{"id": d, "mt": mt} for s, d, mt in SUPPLY if s == pid],
            "water": water,
        }
        p.update(climate_block(pid, coastal))
        if r["water_source"].lower().startswith("desalinated"):
            p["water"]["supply_note"] = ("Runs on desalinated seawater, so its own water supply is largely shielded "
                                         "from basin stress. It remains exposed through its clinker supplier.")
        p["flags"] = flags_for(pid, water)
        plants.append(p)

    # Mass balance check: shipped clinker in the file must equal what the links say
    for r in plants_csv:
        shipped = float(r["clinker_shipped_fy2025_26_mt"])
        linked = round(sum(mt for s, d, mt in SUPPLY if s == r["plant_id"]), 2)
        if abs(shipped - linked) > 0.005:
            raise SystemExit(f"{r['plant_id']}: clinker shipped {shipped} != supply links {linked}")

    implausible = sum(p["rain"]["implausible_days"] for p in plants)
    data = {
        "meta": {
            "built_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "company": "Nimbus Cement Ltd (fictional)",
            "revenue_total_cr": sum(p["revenue_cr"] for p in plants),
            "asset_total_cr": sum(p["asset_cr"] for p in plants),
            "periods": {"today": "2010-2025", "future": "2030-2045"},
            "retrieved": retrieval_window(),
            "models": MODELS,
            "heat_threshold_c": HEAT_THRESHOLD,
            "heavy_rain_mm": HEAVY_RAIN_MM,
            "rain_quality": {"implausible_threshold_mm": IMPLAUSIBLE_MM, "implausible_days": implausible,
                             "max_day_mm": max(p["rain"]["max_day_mm"] for p in plants)},
            "flag_sources": FLAG_SOURCES,
            "references": REFERENCES,
        },
        "defaults": {"heat_medium_days": 10, "heat_high_days": 30, "water_high_from": "High"},
        "plants": plants,
    }
    OUT.write_text(json.dumps(data, indent=1), encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB), {len(plants)} plants, "
          f"{implausible} implausible rain days flagged")


if __name__ == "__main__":
    main()
