"""
Check each climate model's rainfall against IMD observed rainfall, 2010-2024.

    python pipeline/validate_rain_imd.py

Pass rule, fixed before the IMD data was seen:
  - Models do not reproduce real dates, so long-run statistics are compared, not days.
  - A model passes at a plant if
      heavy-rain days a year (>= 64.5 mm) are within +/-50% of IMD's
      (or within 1 day where IMD has fewer than 2 a year), AND
      annual total rainfall is within +/-20% of IMD's.
  - A model is trusted if it passes at 7 or more of the 9 plants.
  - Rain is rated only if 3 or more models are trusted, using only those models.
Writes data/validation/rain_imd_check.json.
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS = ["CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S",
          "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S"]
HEAVY = 64.5
YEARS = [str(y) for y in range(2010, 2025)]


def imd_stats():
    rows = defaultdict(list)
    cells = {}
    with open(ROOT / "data" / "raw" / "imd" / "imd_daily_rain_2010_2024.csv", newline="") as f:
        for r in csv.DictReader(f):
            if r["date"][:4] in YEARS and r["rain_mm"] not in ("", "nan", "NaN"):
                rows[r["plant_id"]].append(float(r["rain_mm"]))
                cells[r["plant_id"]] = (r["cell_lat"], r["cell_lon"])
    n = len(YEARS)
    return {p: {"heavy_days": sum(x >= HEAVY for x in v) / n, "annual_mm": sum(v) / n,
                "days": len(v), "cell": cells[p]} for p, v in rows.items()}


def model_stats(pid):
    d = json.loads((ROOT / "data" / "raw" / "openmeteo" / f"{pid}_today_2010-2025.json").read_text())["daily"]
    keep = [i for i, t in enumerate(d["time"]) if t[:4] in YEARS]
    n = len(YEARS)
    out = {}
    for m in MODELS:
        pr = [d[f"precipitation_sum_{m}"][i] for i in keep]
        out[m] = {"heavy_days": sum(x >= HEAVY for x in pr) / n, "annual_mm": sum(pr) / n}
    return out


def passes(mod, obs):
    if obs["heavy_days"] < 2:
        heavy_ok = abs(mod["heavy_days"] - obs["heavy_days"]) <= 1
    else:
        heavy_ok = abs(mod["heavy_days"] - obs["heavy_days"]) <= 0.5 * obs["heavy_days"]
    annual_ok = abs(mod["annual_mm"] - obs["annual_mm"]) <= 0.2 * obs["annual_mm"]
    return heavy_ok, annual_ok


def main():
    imd = imd_stats()
    result = {"rule": "heavy days within +/-50% (or 1 day if IMD < 2/yr) AND annual within +/-20%; trusted = passes at >= 7 of 9 plants; rate rain if >= 3 trusted",
              "years": f"{YEARS[0]}-{YEARS[-1]}", "plants": {}, "models": {}}
    wins = defaultdict(int)
    for pid in sorted(imd):
        ms = model_stats(pid)
        row = {"imd": {k: round(v, 2) if isinstance(v, float) else v for k, v in imd[pid].items()}, "models": {}}
        for m in MODELS:
            h, a = passes(ms[m], imd[pid])
            row["models"][m] = {"heavy_days": round(ms[m]["heavy_days"], 2), "annual_mm": round(ms[m]["annual_mm"]),
                                "heavy_ok": h, "annual_ok": a, "pass": h and a}
            wins[m] += h and a
        result["plants"][pid] = row
    for m in MODELS:
        result["models"][m] = {"plants_passed": wins[m], "trusted": wins[m] >= 7}
    trusted = [m for m in MODELS if wins[m] >= 7]
    result["trusted_models"] = trusted
    result["rate_rain"] = len(trusted) >= 3
    out = ROOT / "data" / "validation"
    out.mkdir(parents=True, exist_ok=True)
    (out / "rain_imd_check.json").write_text(json.dumps(result, indent=1))
    print(f"{'plant':6}{'IMD heavy':>10}{'IMD mm':>8}  " + "  ".join(m[:8] for m in MODELS))
    for pid, row in result["plants"].items():
        cells = "  ".join(("PASS    " if v["pass"] else ("h" if v["heavy_ok"] else "-") + ("a" if v["annual_ok"] else "-") + "      ")
                          for v in row["models"].values())
        print(f"{pid:6}{row['imd']['heavy_days']:>10.2f}{row['imd']['annual_mm']:>8.0f}  {cells}")
    print("plants passed:", {m: wins[m] for m in MODELS})
    print("trusted:", trusted, "| rate rain:", result["rate_rain"])


if __name__ == "__main__":
    main()
