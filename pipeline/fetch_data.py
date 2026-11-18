"""
Nimbus Cement climate-risk prototype: data fetch script.

Run on a laptop with internet access:
    python -m pip install requests geopandas
    python fetch_data.py

What it does
  A. Open-Meteo Climate API: daily max temperature and daily precipitation for
     each of the 9 plants, from all 7 CMIP6 models, for two periods:
       today  = 2010-01-01 to 2025-12-31
       future = 2030-01-01 to 2045-12-31
     Raw JSON is saved unchanged. No calculations are done here.
  B. WRI Aqueduct 4.0: downloads the public data ZIP, finds every map layer in
     it, and keeps only the rows for the river basins the 9 plants sit in.
     Also keeps matching rows from any plain tables that share the basin ID.
  C. Writes a manifest (what was fetched, from where, when) and packs
     everything small into nimbus_data_upload.zip for upload.

Safe to re-run: anything already downloaded is skipped.
Everything printed is also written to fetch_log.txt.
"""

import json
import sys
import time
import zipfile
import datetime as dt
from pathlib import Path

OUT = Path(__file__).resolve().parent / "nimbus_output"
LOG_PATH = Path(__file__).resolve().parent / "fetch_log.txt"

PLANTS = [
    ("P01", "Chittorgarh", 24.8887, 74.6269),
    ("P02", "Satna", 24.6005, 80.8322),
    ("P03", "Chandrapur", 19.9615, 79.2961),
    ("P04", "Nalgonda", 17.0575, 79.2671),
    ("P05", "Ariyalur", 11.1401, 79.0786),
    ("P06", "Baloda Bazar", 21.6566, 82.1606),
    ("P07", "Mundra", 22.8390, 69.7219),
    ("P08", "Paradip", 20.3165, 86.6114),
    ("P09", "Durgapur", 23.5204, 87.3119),
]

OM_URL = "https://climate-api.open-meteo.com/v1/climate"
OM_MODELS = [
    "CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S",
    "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S",
]
OM_DAILY = ["temperature_2m_max", "precipitation_sum"]
PERIODS = {
    "today": ("2010-01-01", "2025-12-31"),
    "future": ("2030-01-01", "2045-12-31"),
}

AQ_URL = "https://files.wri.org/aqueduct/aqueduct-4-0-water-risk-data.zip"


# ---------------------------------------------------------------- logging
_log_file = open(LOG_PATH, "a", encoding="utf-8")


def log(msg=""):
    line = f"[{dt.datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    _log_file.write(line + "\n")
    _log_file.flush()


def now_utc():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


manifest = {"script_started_utc": now_utc(), "python": sys.version, "open_meteo": [], "aqueduct": {}}


# ---------------------------------------------------------------- A. Open-Meteo
def fetch_open_meteo():
    import requests

    folder = OUT / "openmeteo"
    folder.mkdir(parents=True, exist_ok=True)
    for pid, name, lat, lon in PLANTS:
        for label, (start, end) in PERIODS.items():
            path = folder / f"{pid}_{label}_{start[:4]}-{end[:4]}.json"
            if path.exists() and path.stat().st_size > 1000:
                log(f"Open-Meteo {pid} {label}: already have it, skipping")
                continue
            params = {
                "latitude": lat,
                "longitude": lon,
                "start_date": start,
                "end_date": end,
                "models": ",".join(OM_MODELS),
                "daily": ",".join(OM_DAILY),
            }
            for attempt in range(1, 7):
                try:
                    r = requests.get(OM_URL, params=params, timeout=180)
                except requests.RequestException as e:
                    log(f"Open-Meteo {pid} {label}: network error ({e}), retry {attempt}/6 in 30 s")
                    time.sleep(30)
                    continue
                if r.status_code == 200:
                    data = r.json()
                    path.write_text(json.dumps(data), encoding="utf-8")
                    n_days = len(data.get("daily", {}).get("time", []))
                    log(f"Open-Meteo {pid} {label}: saved {n_days} days")
                    manifest["open_meteo"].append({
                        "plant": pid, "period": label, "url": r.url,
                        "retrieved_utc": now_utc(), "days": n_days, "file": path.name,
                    })
                    break
                if r.status_code == 429:
                    wait = 60 * attempt
                    log(f"Open-Meteo {pid} {label}: rate limited, waiting {wait} s (try {attempt}/6)")
                    time.sleep(wait)
                    continue
                if r.status_code >= 500:
                    log(f"Open-Meteo {pid} {label}: server error {r.status_code}, retry in 30 s")
                    time.sleep(30)
                    continue
                # 4xx other than 429: log it, then try one model at a time
                log(f"Open-Meteo {pid} {label}: all-models request refused {r.status_code}: {r.text[:300]}")
                log(f"Open-Meteo {pid} {label}: retrying one model at a time")
                merged, urls = None, []
                for m in OM_MODELS:
                    one = dict(params, models=m)
                    r1 = requests.get(OM_URL, params=one, timeout=180)
                    time.sleep(3)
                    if r1.status_code != 200:
                        log(f"    {m}: FAILED {r1.status_code}: {r1.text[:200]}")
                        continue
                    d = r1.json()
                    urls.append(r1.url)
                    if merged is None:
                        merged = d
                        merged["daily"] = {"time": d["daily"]["time"]}
                    for k, v in d["daily"].items():
                        if k != "time":
                            merged["daily"][k if k.endswith(m) else f"{k}_{m}"] = v
                    log(f"    {m}: ok")
                if merged:
                    path.write_text(json.dumps(merged), encoding="utf-8")
                    manifest["open_meteo"].append({
                        "plant": pid, "period": label, "url": urls, "retrieved_utc": now_utc(),
                        "days": len(merged["daily"]["time"]), "file": path.name, "per_model": True,
                    })
                break
            else:
                log(f"Open-Meteo {pid} {label}: gave up after 6 tries")
            time.sleep(3)  # be polite to the free API


# ---------------------------------------------------------------- B. Aqueduct
def download(url, dest):
    import requests

    if dest.exists() and dest.stat().st_size > 1_000_000:
        log(f"Aqueduct ZIP already downloaded ({dest.stat().st_size / 1e6:.0f} MB), skipping")
        return
    log(f"Downloading {url} (this can take a while)")
    tmp = dest.with_suffix(".part")
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done, last = 0, 0
        with open(tmp, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
                done += len(chunk)
                if done - last > 50 << 20:
                    last = done
                    pct = f" of {total / 1e6:.0f} MB" if total else ""
                    log(f"  {done / 1e6:.0f} MB{pct}")
    tmp.replace(dest)
    log(f"Download complete: {dest.stat().st_size / 1e6:.0f} MB")


def fetch_aqueduct():
    import pandas as pd
    import geopandas as gpd
    import pyogrio

    folder = OUT / "aqueduct_raw"
    folder.mkdir(parents=True, exist_ok=True)
    zpath = folder / "aqueduct-4-0-water-risk-data.zip"
    download(AQ_URL, zpath)
    manifest["aqueduct"]["url"] = AQ_URL
    manifest["aqueduct"]["zip_bytes"] = zpath.stat().st_size
    manifest["aqueduct"]["retrieved_utc"] = now_utc()

    extract = folder / "extracted"
    if not extract.exists():
        log("Unzipping Aqueduct data")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(extract)
            # Some releases contain zips inside the zip
        for inner in list(extract.rglob("*.zip")):
            log(f"  unzipping inner archive {inner.name}")
            with zipfile.ZipFile(inner) as z:
                z.extractall(inner.with_suffix(""))

    # Record the full file listing so the structure can be checked later
    listing = sorted(
        f"{p.relative_to(extract)}\t{p.stat().st_size}" for p in extract.rglob("*") if p.is_file()
    )
    (OUT / "aqueduct_file_listing.txt").write_text("\n".join(listing), encoding="utf-8")
    log(f"Aqueduct archive holds {len(listing)} files; listing saved")

    points = gpd.GeoDataFrame(
        {"plant_id": [p[0] for p in PLANTS], "plant": [p[1] for p in PLANTS]},
        geometry=gpd.points_from_xy([p[3] for p in PLANTS], [p[2] for p in PLANTS]),
        crs="EPSG:4326",
    )
    bbox = (68.0, 10.0, 89.0, 26.0)  # lon/lat box around all 9 plants

    sources = [p for p in extract.rglob("*.gdb") if p.is_dir()]
    sources += list(extract.rglob("*.gpkg")) + list(extract.rglob("*.shp")) + list(extract.rglob("*.geojson"))
    matched_dir = OUT / "aqueduct_matches"
    matched_dir.mkdir(exist_ok=True)
    basin_ids = set()
    plain_layers = []

    for src in sources:
        try:
            layers = pyogrio.list_layers(src)
        except Exception as e:
            log(f"  cannot list layers in {src.name}: {e}")
            continue
        for layer_name, geom_type in layers:
            tag = f"{src.stem}__{layer_name}"
            if geom_type is None:
                log(f"  {tag}: table without geometry, will match on basin ID later")
                plain_layers.append((src, layer_name, tag))
                continue
            try:
                gdf = pyogrio.read_dataframe(src, layer=layer_name, bbox=bbox)
            except Exception as e:
                log(f"  {tag}: could not read with bbox ({e}); trying full read")
                try:
                    gdf = gpd.read_file(src, layer=layer_name)
                except Exception as e2:
                    log(f"  {tag}: FAILED to read ({e2})")
                    continue
            if gdf.empty:
                log(f"  {tag}: nothing inside the India box")
                continue
            if gdf.crs is None:
                gdf = gdf.set_crs("EPSG:4326")
            hits = gpd.sjoin(points, gdf.to_crs("EPSG:4326"), how="left", predicate="within")
            out = pd.DataFrame(hits.drop(columns="geometry"))
            out.to_csv(matched_dir / f"{_safe(tag)}.csv", index=False)
            found = out.loc[out["index_right"].notna(), "plant_id"].nunique() if "index_right" in out else 0
            log(f"  {tag}: {len(gdf)} shapes in box, wrote {len(out)} rows for {found} plants")
            for col in out.columns:
                if col.lower() in ("pfaf_id", "pfafid", "pfaf_id_left", "pfaf_id_right", "aq30_id", "string_id"):
                    basin_ids.update(str(v) for v in out[col].dropna().unique())

    manifest["aqueduct"]["basin_ids_found"] = sorted(basin_ids)
    log(f"Basin IDs found for plants: {sorted(basin_ids)[:20]}")

    # Tables without geometry: keep only rows for those basins
    for src, layer_name, tag in plain_layers:
        try:
            df = pyogrio.read_dataframe(src, layer=layer_name, read_geometry=False)
            _match_table(df, tag, matched_dir, basin_ids)
        except Exception as e:
            log(f"  {tag}: could not read ({e})")

    # Plain CSV tables: keep only rows for those basins
    for csv in extract.rglob("*.csv"):
        try:
            df = pd.read_csv(csv, low_memory=False)
        except Exception as e:
            log(f"  {csv.name}: could not read ({e})")
            continue
        _match_table(df, csv.stem, matched_dir, basin_ids)


def _match_table(df, tag, matched_dir, basin_ids=None):
    import pandas as pd  # noqa: F401

    ids = basin_ids or set()
    for col in df.columns:
        if col.lower() in ("pfaf_id", "pfafid", "aq30_id", "string_id") and ids:
            sub = df[df[col].astype(str).isin(ids)]
            if len(sub):
                sub.to_csv(matched_dir / f"table__{_safe(tag)}__{col}.csv", index=False)
                log(f"  table {tag}: kept {len(sub)} rows matching plant basins via {col}")
            return
    log(f"  table {tag}: no basin-ID column, skipped (columns: {list(df.columns)[:8]}...)")


def _safe(s):
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in s)[:120]


# ---------------------------------------------------------------- C. pack up
def pack():
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    dest = Path(__file__).resolve().parent / "nimbus_data_upload.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for p in OUT.rglob("*"):
            if p.is_file() and "aqueduct_raw" not in p.parts:
                z.write(p, p.relative_to(OUT.parent))
        z.write(LOG_PATH, LOG_PATH.name)
    log(f"Packed {dest.name} ({dest.stat().st_size / 1e6:.1f} MB). Upload this file and you're done.")


def main():
    OUT.mkdir(exist_ok=True)
    log("=" * 60)
    log("Nimbus data fetch started")
    try:
        import requests  # noqa: F401
    except ImportError:
        log("Missing package. Run:  python -m pip install requests geopandas")
        return
    log("Part A: Open-Meteo climate projections (18 requests)")
    fetch_open_meteo()
    log("Part B: WRI Aqueduct 4.0")
    try:
        fetch_aqueduct()
    except ImportError:
        log("Aqueduct step needs geopandas. Run:  python -m pip install geopandas   then re-run.")
    except Exception as e:
        log(f"Aqueduct step FAILED: {type(e).__name__}: {e}")
        log("Open-Meteo results are still packed. Send the log and we'll fix this part.")
    manifest["script_finished_utc"] = now_utc()
    pack()


if __name__ == "__main__":
    main()
