"""
Build site/map.json: India outline (Natural Earth 1:10m, India point of view) plus neighbours,
projected and simplified to SVG paths.

Source: Natural Earth ne_10m_admin_0_countries_ind.geojson (public domain), which draws
boundaries as India officially depicts them.
    python pipeline/build_map.py path/to/ne_10m_admin_0_countries_ind.geojson
"""
import json, math, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LON0, LON1, LAT0, LAT1 = 66.0, 99.5, 5.5, 37.8
KX = math.cos(math.radians(22))          # equirectangular, scaled at India's mid-latitude
W = 1000.0
H = W * (LAT1 - LAT0) / ((LON1 - LON0) * KX)
KEEP = {"IND": "India", "PAK": "Pakistan", "CHN": "China", "NPL": "Nepal", "BGD": "Bangladesh",
        "BTN": "Bhutan", "MMR": "Myanmar", "LKA": "Sri Lanka", "AFG": "Afghanistan"}

def proj(lon, lat):
    return ((lon - LON0) / (LON1 - LON0) * W, (LAT1 - lat) / (LAT1 - LAT0) * H)

def dp(pts, tol):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]
    dx, dy = b[0]-a[0], b[1]-a[1]; n = math.hypot(dx, dy) or 1e-9
    i, dmax = 0, 0
    for k in range(1, len(pts)-1):
        d = abs(dy*pts[k][0] - dx*pts[k][1] + b[0]*a[1] - b[1]*a[0]) / n
        if d > dmax: i, dmax = k, d
    if dmax <= tol: return [a, b]
    return dp(pts[:i+1], tol)[:-1] + dp(pts[i:], tol)

def area(ring):
    return abs(sum(x1*y2 - x2*y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2

def to_path(geom, tol, min_area):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    out = []
    for poly in polys:
        ring = [proj(x, y) for x, y in poly[0]]
        if all(not (-50 < x < W + 50 and -50 < y < H + 50) for x, y in ring): continue
        if area(ring) < min_area: continue
        # A closed ring starts and ends on the same point, which defeats Douglas-Peucker;
        # simplify the two halves separately.
        h = len(ring) // 2
        s = dp(ring[:h + 1], tol)[:-1] + dp(ring[h:], tol)
        if len(s) < 4: continue
        out.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in s) + "Z")
    return "".join(out)

def main(src):
    d = json.load(open(src, encoding="utf-8"))
    shapes = []
    for f in d["features"]:
        a3 = f["properties"].get("ADM0_A3")
        if a3 in KEEP:
            path = to_path(f["geometry"], tol=0.9, min_area=6 if a3 == "IND" else 60)
            if path: shapes.append({"id": a3, "name": KEEP[a3], "d": path})
    out = {"width": W, "height": round(H, 1), "bounds": [LON0, LAT0, LON1, LAT1], "kx": KX,
           "source": "Natural Earth 1:10m Admin 0, India point of view (public domain)", "shapes": shapes}
    p = ROOT / "site" / "map.json"
    p.write_text(json.dumps(out), encoding="utf-8")
    print(f"Wrote {p.relative_to(ROOT)} ({p.stat().st_size/1024:.0f} KB):", [(s['id'], len(s['d'])) for s in shapes])

if __name__ == "__main__":
    main(sys.argv[1])
