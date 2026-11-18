"use strict";
/* Nimbus Cement · physical climate exposure prototype (v1.1).
   Reads data.json (built by pipeline/build_data.py) and map.json (pipeline/build_map.py). */

const S = { data: null, map: null, settings: null, chainMode: "adjusted" };
const ORDER = { "Low": 0, "Medium": 1, "High": 2 };
const AQ_ORDER = ["Low", "Low-medium", "Medium-high", "High", "Extremely high"];
const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtCr = v => "₹" + Math.round(v).toLocaleString("en-IN") + " cr";
const pct = (a, b) => Math.round(100 * a / b) + "%";
const d1 = v => (Math.round(v * 10) / 10).toString();
const share = raw => raw > 1 ? `withdrawals are ${d1(raw)}× renewable supply` : `${Math.round(raw * 100)}% of renewable supply withdrawn`;
const shareShort = raw => raw > 1 ? `${d1(raw)}× supply` : `${Math.round(raw * 100)}%`;
const lc = s => s.charAt(0).toLowerCase() + s.slice(1);

/* ---------- Source lines: every figure names its source and its kind ---------- */
const SRC = {
  aq: '<a href="#method">WRI Aqueduct 4.0</a> <em class="k k-m">modelled</em>',
  om: '<a href="#method">Open-Meteo, 7 climate models</a> <em class="k k-m">modelled</em>',
  nim: 'Nimbus plant file <em class="k k-n">company data</em>',
  thr: 'rating thresholds <em class="k k-a">our assumption</em>',
  rule: 'supply-link rule <em class="k k-a">our assumption</em>',
  buffer: 'no stock buffer or other supplier <em class="k k-a">our assumption</em>',
  rec: 'named past events <em class="k k-r">historical record</em>',
  imd: '<a href="#method">IMD gridded rainfall</a> <em class="k k-r">observed record</em>',
};
const src = (...keys) => `<p class="src">Source: ${keys.map(k => SRC[k]).join(" · ")}</p>`;

/* ---------- Settings ---------- */
function loadSettings() {
  const def = S.data.defaults;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("nimbus-settings") || "null"); } catch (e) { saved = null; }
  const s = Object.assign({}, def, saved || {});
  return validSettings(s) ? s : Object.assign({}, def);
}
function validSettings(s) {
  return Number.isFinite(s.heat_medium_days) && Number.isFinite(s.heat_high_days) &&
    s.heat_medium_days >= 0 && s.heat_high_days >= s.heat_medium_days && s.heat_high_days <= 365 &&
    ["High", "Extremely high"].includes(s.water_high_from);
}
function isCustom() {
  const d = S.data.defaults, s = S.settings;
  return s.heat_medium_days !== d.heat_medium_days || s.heat_high_days !== d.heat_high_days || s.water_high_from !== d.water_high_from;
}
function saveSettings(s) {
  S.settings = s;
  try { localStorage.setItem("nimbus-settings", JSON.stringify(s)); } catch (e) { /* storage unavailable: keep in memory */ }
  document.body.classList.toggle("custom", isCustom());
  route();
}

/* ---------- Ratings ---------- */
function waterRating(cat) {
  if (!cat) return "No data";
  const i = AQ_ORDER.indexOf(cat), hi = AQ_ORDER.indexOf(S.settings.water_high_from);
  if (i >= hi) return "High";
  if (i >= AQ_ORDER.indexOf("Medium-high")) return "Medium";
  return "Low";
}
function heatRating(days) {
  if (days == null || !Number.isFinite(days)) return "No data";
  if (days < S.settings.heat_medium_days) return "Low";
  if (days <= S.settings.heat_high_days) return "Medium";
  return "High";
}
const plant = id => S.data.plants.find(p => p.id === id);
const waterCat = (p, when) => when === "today" ? p.water.baseline.category : p.water.future.pes.p2030.category;
const waterOwn = (p, when) => waterRating(waterCat(p, when));
function waterAdjusted(p, when) {
  let r = waterOwn(p, when);
  for (const s of p.receives_from) {
    const sr = waterOwn(plant(s.id), when);
    if ((ORDER[sr] ?? -1) > (ORDER[r] ?? -1)) r = sr;
  }
  return r;
}
const heatOwn = (p, when) => heatRating(p.heat.days[when].median);
function ratingHTML(r) {
  const cls = r === "No data" ? "NoData" : r === "Not rated" ? "NotRated" : r === "Flag" ? "NotRated" : r;
  return `<span class="rating ${cls}">${esc(r === "Flag" ? "Current only" : r)}</span>`;
}
const pair = (a, b) => `<span class="pair">${ratingHTML(a)}<span class="arrow" aria-label="to">→</span>${ratingHTML(b)}</span>`;
function agreement(block) {
  const up = block.models_up, down = block.models_down;
  if (Math.max(up, down) < 5) return `models disagree on direction (${up} of 7 higher, ${down} lower)`;
  return up >= down ? `${up} of 7 models show an increase` : `${down} of 7 models show a decrease`;
}
const dependentRevenue = p => p.revenue_cr + p.supplies_to.reduce((t, s) => t + plant(s.id).revenue_cr, 0);

/* ---------- Rollups ---------- */
function rollup() {
  const P = S.data.plants, R = S.data.meta.revenue_total_cr;
  const sum = (arr, k) => arr.reduce((t, p) => t + p[k], 0);
  const out = { R };
  for (const when of ["today", "future"]) {
    const own = P.filter(p => waterOwn(p, when) === "High");
    const adj = P.filter(p => waterAdjusted(p, when) === "High");
    const heat = P.filter(p => heatOwn(p, when) === "High");
    out[when] = { waterOwnRev: sum(own, "revenue_cr"), waterAdjRev: sum(adj, "revenue_cr"), waterAdjIds: adj.map(p => p.id),
      heatIds: heat.map(p => p.id), heatRev: sum(heat, "revenue_cr") };
  }
  out.heatRising = P.filter(p => p.heat.days.future.median > p.heat.days.today.median);
  out.kilns = P.filter(p => p.supplies_to.length);
  return out;
}

/* ---------- Router ---------- */
function setTab(name) {
  document.querySelectorAll("nav.tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.tab === name ? "page" : "false"));
}
function route() {
  if (!S.data) return;
  const h = location.hash || "#overview";
  const m = h.match(/^#plant-(P0\d)$/);
  const app = $("#app");
  hideTip();
  if (h === "#overview" || h === "#") { setTab("overview"); app.innerHTML = viewOverview(); bindPlantLinks(); }
  else if (h === "#plants") { setTab("plants"); app.innerHTML = viewPlants(); bindPlantLinks(); }
  else if (m) { setTab("plants"); const p = plant(m[1]); app.innerHTML = p ? viewPlant(p) : viewNotFound(m[1]); }
  else if (h === "#supply") { setTab("supply"); app.innerHTML = viewSupply(); bindSupply(); }
  else if (h === "#method") { setTab("method"); app.innerHTML = viewMethod(); }
  else { setTab(""); app.innerHTML = viewNotFound(h); }
  window.scrollTo(0, 0);
}

/* ---------- Overview: three findings ---------- */
function viewOverview() {
  const r = rollup(), t = r.today, f = r.future, s = S.settings;
  const waterSame = t.waterAdjIds.join() === f.waterAdjIds.join();
  const heatSame = t.heatIds.join() === f.heatIds.join();
  const persists = waterSame && heatSame;
  const kilnLines = r.kilns.map(k => {
    const dep = dependentRevenue(k);
    return `<strong>${esc(k.short)}</strong>: ${fmtCr(dep)} (${pct(dep, r.R)}) depends on it`;
  }).join("<br>");
  const storm = S.data.plants.filter(p => p.flags.some(x => x.type === "coastal_storm")).map(p => esc(p.short)).join(" and ");
  const flood = S.data.plants.filter(p => p.flags.some(x => x.type === "river_flood")).map(p => esc(p.short)).join(", ");
  return `
  <h1>Three things the board should know</h1>
  <p class="lede">Physical climate exposure of Nimbus Cement's 9 plants, today (2010–2025 climate) and in a 2040 view (2030–2045, high-emissions stress test). These are exposures, not loss estimates.</p>

  <section class="card finding" aria-labelledby="f1">
    <div>
      <div class="num">1</div>
      <h2 id="f1">Water is the main exposure.</h2>
      <div class="stat">${pct(t.waterAdjRev, r.R)} <small>of revenue · ${fmtCr(t.waterAdjRev)}</small></div>
      <p class="fact">comes from ${t.waterAdjIds.length} of 9 plants under high water stress, counting their clinker suppliers. ${waterSame ? "The same plants stay under high stress in the 2040 view." : `In the 2040 view: ${pct(f.waterAdjRev, r.R)}.`}</p>
      <a class="more" href="#plants">See every plant →</a>
      ${src("aq", "nim", "rule")}
    </div>
    <div class="visual">${mapSVG()}
      <div class="legend"><span><span class="sw" style="background:var(--high)"></span>High water stress</span><span><span class="sw" style="background:var(--medium)"></span>Medium</span><span><span class="sw" style="background:#b7cbcf"></span>Low</span><span><span class="ln"></span>Clinker supply</span></div>
      <p class="small muted" style="margin:6px 0 0">Today's rating. Boundaries as officially depicted by India.</p>
    </div>
  </section>

  <section class="card finding" aria-labelledby="f2">
    <div>
      <div class="num">2</div>
      <h2 id="f2">Heat is widespread, and rising at most plants.</h2>
      <div class="stat">${t.heatIds.length} of 9 <small>plants</small></div>
      <p class="fact">already have more than ${s.heat_high_days} days a year at IMD's heatwave threshold. By the 2040 view, hot days rise at ${r.heatRising.length} of 9 plants (median of 7 climate models).</p>
      <a class="more" href="#plants">See every plant →</a>
      ${src("om", "thr")}
    </div>
    <div class="visual">${dumbbellSVG()}
      <div class="legend"><span><span class="sw" style="background:#fff;border:1.8px solid #3e5a63"></span>2010–2025</span><span><span class="sw" style="background:#13303a"></span>2030–2045</span><span>Days a year at or above 40°C (37°C on the coast)</span></div>
    </div>
  </section>

  <section class="card finding" aria-labelledby="f3">
    <div>
      <div class="num">3</div>
      <h2 id="f3">Two kiln plants are single points of failure.</h2>
      <p class="fact">Three grinding units have no kiln and depend entirely on clinker from one plant. If that plant stops, they stop too.</p>
      <p class="fact">${kilnLines}</p>
      <a class="more" href="#supply">See the supply chain →</a>
      ${src("nim", "buffer")}
    </div>
    <div class="visual">${miniChainSVG()}</div>
  </section>

  <div class="closing">${persists
    ? "<strong>This exposure is structural, not temporary.</strong> It persists through the 2040 view and heat rises at most plants, so it is a basis for decisions now, not a future watch item."
    : "<strong>This exposure changes by the 2040 view.</strong> See each plant for where it grows or eases."}</div>
  <p class="also"><strong>Also shown, not counted above:</strong> coastal storm exposure at ${storm} and river flood exposure at ${flood} (current only, no 2040 projection). Heavy rain is not rated: checked against IMD's observed rainfall, the climate models do not match it at enough plants. <a href="#method">Why</a></p>`;
}
function project(lon, lat) {
  const [L0, A0, L1, A1] = S.map.bounds;
  return [(lon - L0) / (L1 - L0) * S.map.width, (A1 - lat) / (A1 - A0) * S.map.height];
}
const LABEL_POS = { P01: [-20, -16, "end"], P02: [22, 9, "start"], P03: [-22, 9, "end"], P04: [22, 9, "start"], P05: [22, 9, "start"],
  P06: [-22, -14, "end"], P07: [4, 46, "middle"], P08: [-20, 36, "end"], P09: [20, -16, "start"] };
function mapSVG() {
  const M = S.map;
  const shapes = M.shapes.map(s => `<path class="${s.id === "IND" ? "land-ind" : "land-other"}" d="${s.d}"><title>${esc(s.name)}</title></path>`).join("");
  const edges = [];
  for (const p of S.data.plants) for (const t of p.supplies_to) {
    const [x1, y1] = project(p.lon, p.lat), [x2, y2] = project(plant(t.id).lon, plant(t.id).lat);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
    edges.push(`<path class="supply" d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${(mx - dy * 0.18).toFixed(1)},${(my + dx * 0.18).toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" marker-end="url(#arrowhead)"/>`);
  }
  const dots = S.data.plants.map(p => {
    const [x, y] = project(p.lon, p.lat);
    const r = waterAdjusted(p, "today");
    const fill = r === "High" ? "var(--high)" : r === "Medium" ? "var(--medium)" : "#b7cbcf";
    const [lx, ly, anchor] = LABEL_POS[p.id];
    return `<g><circle class="plant-dot" tabindex="0" role="link" aria-label="${esc(p.short)}: water stress ${r}. Open plant." data-id="${p.id}"
      data-tip="${esc(p.id + " " + p.short)}|${esc(p.type)} · ${fmtCr(p.revenue_cr)}|Water stress: ${r}${r !== waterOwn(p, "today") ? " (via supplier)" : ""}"
      cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${p.type === "Integrated" ? 17 : 13}" fill="${fill}"/>
      <text class="plant-label" x="${(x + lx).toFixed(1)}" y="${(y + ly).toFixed(1)}" text-anchor="${anchor}">${esc(p.short)}</text></g>`;
  }).join("");
  return `<svg class="map" viewBox="40 60 ${M.width - 60} ${M.height - 60}" role="img" aria-label="Map of India showing the 9 Nimbus plants coloured by water stress">
    <defs><marker id="arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#3e5a63"/></marker></defs>
    ${shapes}${edges.join("")}${dots}</svg>`;
}
function dumbbellSVG() {
  const P = [...S.data.plants].sort((a, b) => b.heat.days.today.median - a.heat.days.today.median);
  const W = 560, L = 104, R = 70, top = 26, rowH = 27, H = top + rowH * P.length + 18;
  const maxV = Math.max(70, ...P.map(p => Math.max(p.heat.days.today.median, p.heat.days.future.median))) ;
  const x = v => L + (W - L - R) * v / maxV;
  const thr = S.settings.heat_high_days;
  let g = `<line class="thr" x1="${x(thr)}" x2="${x(thr)}" y1="${top - 8}" y2="${H - 18}"/><text class="thr-t" x="${x(thr) + 4}" y="${top - 12}">High above ${thr} days</text>`;
  P.forEach((p, i) => {
    const y = top + rowH * i + 10, a = p.heat.days.today.median, b = p.heat.days.future.median;
    g += `<g class="hrow" data-id="${p.id}" style="cursor:pointer"><title>${esc(p.short)}: ${d1(a)} → ${d1(b)} days (${esc(agreement(p.heat.days))})</title>
      <text class="lbl" x="0" y="${y + 4}">${esc(p.short)}</text>
      <line class="seg-l" x1="${x(a)}" x2="${x(b)}" y1="${y}" y2="${y}"/>
      <circle class="d-today" cx="${x(a)}" cy="${y}" r="5.5"/><circle class="d-fut" cx="${x(b)}" cy="${y}" r="5.5"/>
      <text class="val" x="${W - R + 10}" y="${y + 4}">${Math.round(a)} → ${Math.round(b)}</text></g>`;
  });
  [0, 20, 40, 60].filter(v => v <= maxV).forEach(v => { g += `<text class="ax" x="${x(v)}" y="${H - 2}" text-anchor="middle">${v}</text>`; });
  return `<svg class="dumbbell" viewBox="0 0 ${W} ${H}" role="img" aria-label="Hot days a year at each plant, 2010–2025 and 2030–2045">${g}</svg>`;
}
function miniChainSVG() {
  const box = (x, y, w, p, kiln) => `<g><rect x="${x}" y="${y}" width="${w}" height="46" rx="8" fill="${kiln ? "#e9eff1" : "#fff"}" stroke="#c3cdd2"/>
    <text x="${x + 12}" y="${y + 20}" font-size="13" font-weight="600" fill="#13303a">${esc(p.short)}</text>
    <text x="${x + 12}" y="${y + 37}" font-size="11.5" fill="#3e5a63">${kiln ? "Kiln plant" : "Grinding unit"} · ${fmtCr(p.revenue_cr)}</text></g>`;
  const arrow = (x1, y1, x2, y2) => `<path d="M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2 - 3},${y2}" fill="none" stroke="#3e5a63" stroke-width="1.6" marker-end="url(#ah3)"/>`;
  const P01 = plant("P01"), P07 = plant("P07"), P06 = plant("P06"), P08 = plant("P08"), P09 = plant("P09");
  return `<svg viewBox="0 0 520 250" style="width:100%;height:auto;display:block" role="img" aria-label="Chittorgarh supplies Mundra; Baloda Bazar supplies Paradip and Durgapur">
    <defs><marker id="ah3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3e5a63"/></marker></defs>
    ${arrow(190, 33, 330, 33)}${arrow(190, 168, 330, 128)}${arrow(190, 168, 330, 208)}
    ${box(10, 10, 180, P01, true)}${box(330, 10, 180, P07, false)}
    ${box(10, 145, 180, P06, true)}${box(330, 105, 180, P08, false)}${box(330, 185, 180, P09, false)}
    <text x="260" y="26" font-size="11.5" fill="#3e5a63" text-anchor="middle">1.12 Mt clinker</text>
    <text x="318" y="116" font-size="11.5" fill="#3e5a63" text-anchor="end">0.68 Mt</text>
    <text x="318" y="230" font-size="11.5" fill="#3e5a63" text-anchor="end">0.60 Mt</text></svg>`;
}
function bindPlantLinks() {
  const go = id => { location.hash = "#plant-" + id; };
  document.querySelectorAll("tr.row").forEach(tr => {
    tr.addEventListener("click", () => go(tr.dataset.id));
    tr.addEventListener("keydown", e => { if (e.key === "Enter") go(tr.dataset.id); });
  });
  document.querySelectorAll(".hrow").forEach(g => g.addEventListener("click", () => go(g.dataset.id)));
  document.querySelectorAll(".plant-dot").forEach(c => {
    c.addEventListener("click", () => go(c.dataset.id));
    c.addEventListener("keydown", e => { if (e.key === "Enter") go(c.dataset.id); });
    c.addEventListener("mousemove", e => showTip(e, c.dataset.tip));
    c.addEventListener("focus", () => { const b = c.getBoundingClientRect(); showTip({ clientX: b.right, clientY: b.top }, c.dataset.tip); });
    c.addEventListener("mouseleave", hideTip); c.addEventListener("blur", hideTip);
  });
}
function showTip(e, text) {
  const t = $("#tip"); const [a, ...rest] = text.split("|");
  t.innerHTML = `<strong>${a}</strong><br>${rest.join("<br>")}`;
  t.style.display = "block";
  t.style.left = Math.min(e.clientX + 14, window.innerWidth - 280) + "px";
  t.style.top = (e.clientY + 14) + "px";
}
function hideTip() { const t = $("#tip"); if (t) t.style.display = "none"; }

/* ---------- All plants ---------- */
function viewPlants() {
  const P = [...S.data.plants].sort((a, b) => b.revenue_cr - a.revenue_cr);
  const rows = P.map(p => {
    const flags = p.flags.map(fl => `<span class="flag-pill">${fl.type === "coastal_storm" ? "Coastal storm" : "River flood"}</span>`).join("") || '<span class="muted small">None</span>';
    const via = waterAdjusted(p, "today") !== waterOwn(p, "today");
    return `<tr class="row" tabindex="0" data-id="${p.id}" aria-label="Open ${esc(p.short)} details">
      <td><span class="pname">${p.id} ${esc(p.short)}</span><span class="ptype">${esc(p.type)} · ${esc(p.state)}</span></td>
      <td class="num">${Math.round(p.revenue_cr).toLocaleString("en-IN")}</td>
      <td class="nw">${pair(waterAdjusted(p, "today"), waterAdjusted(p, "future"))}${via ? '<div class="small muted">via supplier</div>' : ""}</td>
      <td class="nw">${pair(heatOwn(p, "today"), heatOwn(p, "future"))}<div class="small muted">${Math.round(p.heat.days.today.median)} → ${Math.round(p.heat.days.future.median)} days</div></td>
      <td>${flags}</td></tr>`;
  }).join("");
  return `
  <h1>All plants, today → 2040 view</h1>
  <p class="lede">Sorted by revenue. Select a plant for the detail behind each rating. Heavy rain is not rated in v1 and is shown on each plant page.</p>
  <div class="card" style="overflow-x:auto">
    <table class="matrix">
      <thead><tr><th>Plant</th><th class="num">Revenue<br>₹ cr</th><th>Water stress<br><span class="muted" style="font-weight:400">incl. supply links</span></th><th>Heat<br><span class="muted" style="font-weight:400">hot days a year</span></th><th>Current flags<br><span class="muted" style="font-weight:400">no 2040 projection</span></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${src("nim", "aq", "om", "thr", "rule")}
  </div>`;
}

/* ---------- Plant detail ---------- */
function rangeSVG(block, unit, bands) {
  const vals = [...Object.values(block.today.by_model), ...Object.values(block.future.by_model)];
  const maxV = Math.max(...vals, bands ? bands.high * 1.25 : 0) * 1.08 || 1;
  const W = 640, L = 92, Rr = 20, rowY = { today: 30, future: 66 }, H = 98;
  const x = v => L + (W - L - Rr) * v / maxV;
  let g = "";
  if (bands) {
    g += `<rect class="band-low" x="${x(0)}" y="12" width="${x(bands.medium) - x(0)}" height="72"/>`;
    g += `<rect class="band-medium" x="${x(bands.medium)}" y="12" width="${Math.max(0, x(bands.high) - x(bands.medium))}" height="72"/>`;
    g += `<rect class="band-high" x="${x(bands.high)}" y="12" width="${Math.max(0, x(maxV) - x(bands.high))}" height="72"/>`;
    g += `<text class="axis-text" x="${(x(0) + x(bands.medium)) / 2}" y="10" text-anchor="middle">Low</text>`;
    g += `<text class="axis-text" x="${(x(bands.medium) + x(bands.high)) / 2}" y="10" text-anchor="middle">Medium</text>`;
    g += `<text class="axis-text" x="${(x(bands.high) + x(maxV)) / 2}" y="10" text-anchor="middle">High</text>`;
  }
  for (const [k, label] of [["today", "2010–2025"], ["future", "2030–2045"]]) {
    const b = block[k], y = rowY[k];
    g += `<text class="row-label" x="0" y="${y + 4}">${label}</text>`;
    g += `<line class="span" x1="${x(b.min)}" x2="${x(b.max)}" y1="${y}" y2="${y}"/>`;
    for (const [m, v] of Object.entries(b.by_model)) g += `<circle class="model" cx="${x(v)}" cy="${y}" r="4"><title>${esc(m)}: ${d1(v)} ${unit}</title></circle>`;
    g += `<circle class="median" cx="${x(b.median)}" cy="${y}" r="6.5"><title>Median of 7 models: ${d1(b.median)} ${unit}</title></circle>`;
    g += `<text class="median-text" x="${x(b.median)}" y="${y - 10}" text-anchor="middle">${d1(b.median)}</text>`;
  }
  const tv = bands ? [0, bands.medium, bands.high, Math.floor(maxV)] : [0, maxV / 2, maxV];
  const ticks = tv.map(v => `<text class="axis-text" x="${x(v)}" y="${H - 2}" text-anchor="middle">${bands ? Math.round(v) : Math.round(v * 10) / 10}</text>`).join("");
  return `<svg class="range" viewBox="0 0 ${W} ${H}" role="img" aria-label="Spread across 7 climate models, today and 2040 view">${g}${ticks}</svg>
    <div class="legend"><span><span class="sw" style="background:#13303a"></span>Median of 7 models</span><span><span class="sw" style="background:#fff;border:1.5px solid var(--model-dot)"></span>One model</span><span>Line: lowest to highest model (${unit})</span></div>`;
}
function plantSummary(p) {
  const w = waterAdjusted(p, "today"), wf = waterAdjusted(p, "future"), h = heatOwn(p, "today"), hf = heatOwn(p, "future");
  const via = w !== waterOwn(p, "today");
  let s = `${w} water stress${via ? " (through its clinker supplier)" : ""} and ${lc(h)} heat today`;
  s += (w === wf && h === hf) ? ", unchanged in the 2040 view." : `; ${lc(wf)} water stress and ${lc(hf)} heat in the 2040 view.`;
  if (p.supplies_to.length) s += ` Supplies all the clinker for ${p.supplies_to.map(t => esc(plant(t.id).short)).join(" and ")}: ${fmtCr(dependentRevenue(p))} of revenue depends on this plant.`;
  if (p.receives_from.length) s += ` Depends entirely on clinker from ${p.receives_from.map(t => esc(plant(t.id).short)).join(" and ")}.`;
  if (p.flags.length) s += ` Also flagged for ${p.flags.map(f => f.type === "coastal_storm" ? "coastal storm" : "river flood").join(" and ")} (current exposure).`;
  return s;
}
function hzRow(name, ratings, line, body, open = false) {
  return `<details class="hz"${open ? " open" : ""}><summary><span class="hz-name">${name}</span><span>${ratings}</span><span class="hz-line">${line}</span><span class="chev" aria-hidden="true">›</span></summary><div class="hz-body">${body}</div></details>`;
}
function flagSources(f) {
  return f.sources.map(k => k === "aqueduct" ? '<a href="#method">WRI Aqueduct 4.0</a>' :
    `<a href="${esc(S.data.meta.flag_sources[k].url)}" target="_blank" rel="noopener">${esc(S.data.meta.flag_sources[k].short)}</a>`).join(" · ");
}
function viewPlant(p) {
  const picker = S.data.plants.map(q => `<a href="#plant-${q.id}" aria-current="${q.id === p.id}">${q.id} ${esc(q.short)}</a>`).join("");
  const w = p.water, hd = p.heat.days, rain = p.rain;
  const own = waterOwn(p, "today"), adj = waterAdjusted(p, "today"), ownF = waterOwn(p, "future"), adjF = waterAdjusted(p, "future");

  const scen = ["opt", "bau", "pes"].map(k => {
    const s = w.future[k];
    return `<tr class="${k === "pes" ? "headline" : ""}"><td>${esc(s.name)}${k === "pes" ? ' <span class="small muted">· used for the 2040 view</span>' : ""}</td>
      <td>${esc(s.p2030.category)} <span class="muted small">(${shareShort(s.p2030.raw)})</span></td>
      <td>${esc(s.p2050.category)} <span class="muted small">(${shareShort(s.p2050.raw)})</span></td></tr>`;
  }).join("");
  const waterBody = `
    <table class="simple"><thead><tr><th>Scenario (Aqueduct 4.0)</th><th>2015–2045 period</th><th>2035–2065 period</th></tr></thead><tbody>${scen}</tbody></table>
    <p class="small muted" style="margin:8px 0 0">Today = Aqueduct baseline (1979–2019 hydrology): ${share(w.baseline.raw)}. Basin ${w.basin_id}. Groundwater trend: ${esc(w.groundwater_trend)}. Drought risk: ${esc(w.drought_risk)}.</p>
    ${w.supply_note ? `<div class="note">${esc(w.supply_note)}</div>` : ""}
    ${adj !== own ? `<div class="note">This plant's own rating is ${ratingHTML(own)} → ${ratingHTML(ownF)}. It is shown as ${ratingHTML(adj)} because its clinker supplier is rated ${adj}.</div>` : ""}
    ${src("aq", "thr", ...(p.receives_from.length ? ["rule"] : []))}`;
  const heatBody = `${rangeSVG(hd, "days", { medium: S.settings.heat_medium_days, high: S.settings.heat_high_days })}
    <p class="small muted" style="margin:8px 0 0">Days reaching IMD's heatwave threshold (40°C on the plains, 37°C at coastal stations), not IMD-declared heatwave days.${p.coastal ? " Humid heat is not covered in v1." : ""}</p>
    ${src("om", "thr")}`;
  const rainBody = `${rangeSVG(rain.heavy_days, "days", null)}
    <div class="note warn">The 7 models disagree widely here (${d1(rain.heavy_days.today.min)} to ${d1(rain.heavy_days.today.max)} heavy-rain days a year today).${rain.implausible_days ? ` This plant's model data includes ${rain.implausible_days} days above 300 mm, which are physically implausible.` : ""} ${rain.imd ? ` <strong>Checked against IMD observed rainfall (${rain.imd.years}):</strong> IMD recorded ${rain.imd.annual_mm} mm and ${rain.imd.heavy_days} heavy-rain days a year here; the models' median is ${rain.imd.models_annual_mm} mm and ${rain.imd.models_heavy_days} days. ${rain.imd.models_passing} of 7 models match IMD at this plant.` : " Rain will be rated after a check against IMD observed rainfall."}</div>
    ${src("om", ...(rain.imd ? ["imd"] : []))}`;

  const rows = [
    hzRow("Water stress", pair(adj, adjF), `${esc(w.baseline.category)} basin stress: ${share(w.baseline.raw)}${adj !== own ? ". Rated through its supplier" : ""}`, waterBody),
    hzRow("Heat", pair(heatOwn(p, "today"), heatOwn(p, "future")), `${Math.round(hd.today.median)} → ${Math.round(hd.future.median)} days a year at or above ${p.heat.threshold_c}°C; ${esc(agreement(hd))}`, heatBody),
    hzRow("Heavy rain", ratingHTML("Not rated"), `${d1(rain.heavy_days.today.median)} → ${d1(rain.heavy_days.future.median)} days a year; models do not match IMD observations`, rainBody),
    ...p.flags.map(f => hzRow(f.type === "coastal_storm" ? "Coastal storm" : "River flood", ratingHTML("Flag"), esc(f.points[0]),
      `<ul style="margin:0;padding-left:20px">${f.points.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
       <p class="src">Sources: ${flagSources(f)} · <em class="k ${f.type === "coastal_storm" ? "k-r" : "k-m"}">${f.type === "coastal_storm" ? "historical record and modelled" : "modelled"}</em> · no 2040 projection</p>`)),
  ].join("");

  const supplyLine = p.receives_from.length
    ? p.receives_from.map(s => { const q = plant(s.id); return `Receives all its clinker (${s.mt} Mt a year) from <a href="#plant-${q.id}">${esc(q.short)}</a>.`; }).join(" ")
    : p.supplies_to.length
      ? `Supplies clinker to ${p.supplies_to.map(s => `<a href="#plant-${s.id}">${esc(plant(s.id).short)}</a> (${s.mt} Mt)`).join(" and ")}. If this plant stops, ${fmtCr(dependentRevenue(p))} of revenue is affected.`
      : "Makes its own clinker and uses all of it. No supply dependency.";

  return `
  <nav class="plant-picker" aria-label="Choose plant">${picker}</nav>
  <div class="card">
    <h1 style="margin-bottom:2px">${esc(p.name)}</h1>
    <div class="muted">${esc(p.type)} · ${esc(p.town)}, ${esc(p.state)} · ${p.coastal ? "Coastal" : "Inland"}</div>
    <p class="summary-line">${plantSummary(p)}</p>
    <div class="profile compact">
      <div><span>Revenue</span><strong>${fmtCr(p.revenue_cr)}</strong></div>
      <div><span>Asset value</span><strong>${fmtCr(p.asset_cr)}</strong></div>
      <div><span>Capacity</span><strong>${p.capacity_mtpa} Mt a year</strong></div>
      <div><span>Water source</span><strong>${esc(p.water_source)}</strong></div>
      <div><span>Employees</span><strong>${p.employees.toLocaleString("en-IN")}</strong></div>
    </div>
    ${src("nim")}
  </div>
  <div class="card" style="margin-top:16px">
    <h2 style="margin-bottom:4px">Hazards, today → 2040 view</h2>
    <p class="small muted" style="margin:0 0 4px">Select a hazard for the detail behind it.</p>
    ${rows}
  </div>
  <div class="card" style="margin-top:16px">
    <h2 style="margin-bottom:6px">Clinker supply</h2>
    <p style="margin:0">${supplyLine}</p>
    ${src("nim", ...(p.receives_from.length || p.supplies_to.length ? ["rule"] : []))}
  </div>`;
}
function viewNotFound(what) {
  return `<div class="state"><h2>Nothing found for “${esc(what)}”</h2><p class="muted">That page or plant does not exist.</p><a class="btn" href="#overview">Back to overview</a></div>`;
}

/* ---------- Supply chain ---------- */
function viewSupply() {
  const r = rollup(), mode = S.chainMode;
  const nodes = { P01: [30, 40], P07: [430, 40], P06: [30, 170], P08: [430, 130], P09: [430, 210] };
  const rate = id => mode === "adjusted" ? waterAdjusted(plant(id), "today") : waterOwn(plant(id), "today");
  const node = id => { const [x, y] = nodes[id], p = plant(id);
    return `<g class="node"><rect x="${x}" y="${y}" width="230" height="58" rx="9"/>
      <text x="${x + 14}" y="${y + 23}">${id} ${esc(p.short)}</text>
      <text class="t2" x="${x + 14}" y="${y + 43}">${esc(p.type)} · ${fmtCr(p.revenue_cr)}</text>
      <foreignObject x="${x + 142}" y="${y + 9}" width="82" height="26"><div xmlns="http://www.w3.org/1999/xhtml">${ratingHTML(rate(id))}</div></foreignObject></g>`; };
  const edge = (a, b, label) => { const [x1, y1] = nodes[a], [x2, y2] = nodes[b];
    const sx = x1 + 230, sy = y1 + 29, ex = x2, ey = y2 + 29;
    return `<path class="edge" d="M${sx},${sy} C${sx + 80},${sy} ${ex - 80},${ey} ${ex - 4},${ey}" marker-end="url(#ah2)"/>
      <text class="edge-label" x="${ex - 12}" y="${ey - 8}" text-anchor="end">${label}</text>`; };
  const disrupt = r.kilns.map(p => {
    const dep = p.supplies_to.map(s => plant(s.id));
    const tot = dependentRevenue(p);
    return `<tr><td>${esc(p.short)}</td><td class="num">${fmtCr(p.revenue_cr)}</td><td>${dep.map(q => `${esc(q.short)} (${fmtCr(q.revenue_cr)})`).join(", ")}</td><td class="num"><strong>${fmtCr(tot)}</strong> · ${pct(tot, r.R)}</td></tr>`;
  }).join("");
  const self = S.data.plants.filter(p => !p.supplies_to.length && !p.receives_from.length).map(p => esc(p.short)).join(", ");
  return `
  <h1>Three grinding units depend on two kilns</h1>
  <p class="lede">Mundra, Paradip and Durgapur have no kiln. They cannot make cement if their clinker supplier stops, so looking at each plant on its own understates their exposure.</p>
  <div class="card">
    <h2>If a kiln plant stops</h2>
    <table class="simple"><thead><tr><th>Kiln plant</th><th>Own revenue</th><th>Grinding units that stop</th><th>Revenue affected</th></tr></thead><tbody>${disrupt}</tbody></table>
    ${src("nim", "buffer")}
  </div>
  <div class="card" style="margin-top:16px">
    <div class="map-head"><h2 style="margin:0">How this changes the water stress ratings</h2>
      <div class="seg" role="group" aria-label="Rating mode">
        <button type="button" data-m="own" aria-pressed="${mode === "own"}">Plant only</button>
        <button type="button" data-m="adjusted" aria-pressed="${mode === "adjusted"}">Including supply links</button>
      </div></div>
    <svg class="chain" viewBox="0 0 700 290" role="img" aria-label="Clinker supply diagram with water stress ratings">
      <defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#3e5a63"/></marker></defs>
      ${edge("P01", "P07", "1.12 Mt by rail")}${edge("P06", "P08", "0.68 Mt")}${edge("P06", "P09", "0.60 Mt")}
      ${["P01", "P07", "P06", "P08", "P09"].map(node).join("")}
    </svg>
    <p class="small" style="margin:6px 0 0"><strong>Rule:</strong> a grinding unit's water rating is the worse of its own and its supplier's. Revenue at high water stress: <strong>${pct(r.today.waterOwnRev, r.R)}</strong> plant only, <strong>${pct(r.today.waterAdjRev, r.R)}</strong> including supply links. Paradip is the plant that moves: Medium on its own, High through Baloda Bazar.</p>
    <p class="small muted" style="margin:4px 0 0">No supply dependency: ${self}.</p>
    ${src("nim", "aq", "rule")}
  </div>`;
}
function bindSupply() {
  document.querySelectorAll(".seg button[data-m]").forEach(b => b.addEventListener("click", () => { S.chainMode = b.dataset.m; route(); }));
}

/* ---------- Methodology ---------- */
function viewMethod() {
  const m = S.data.meta, d = S.data.defaults;
  const ref = k => { const i = m.references.findIndex(r => r.key === k); return `<a href="${esc(m.references[i].url)}" target="_blank" rel="noopener">[${i + 1}]</a>`; };
  const refs = m.references.map(r => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join("");
  const events = Object.values(m.flag_sources).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join("");
  return `<div class="method">
  <h1>Methodology and sources</h1>
  <p class="lede">How every number is produced. Data downloaded ${esc(m.retrieved.date)}, ${esc(m.retrieved.first_utc)}–${esc(m.retrieved.last_utc)} UTC. The processing scripts and raw downloads are kept with the prototype, so each figure can be regenerated.</p>

  <div class="card"><h2>What this answers, and what it does not</h2>
    <ul><li><strong>Answers:</strong> which plants, and how much revenue, are exposed to physical climate hazards today and in a 2040 view.</li>
    <li><strong>Does not answer:</strong> how much money Nimbus would lose. Ratings measure exposure, not damage.</li>
    <li><strong>Not in v1:</strong> transition risk (carbon pricing, CCTS), humid heat, flood and cyclone projections, losses, adaptation planning.</li>
    <li><strong>Source kinds:</strong> every figure is marked <em class="k k-m">modelled</em>, <em class="k k-n">company data</em>, <em class="k k-a">our assumption</em> or <em class="k k-r">historical record</em>.</li></ul>
  </div>

  <section class="card"><h2>Water stress · rated, leads the overview</h2><dl>
    <dt>Source</dt><dd>WRI Aqueduct 4.0 ${ref("aqueduct")} ${ref("aqueduct_note")}, river-basin level. Each plant matched to its basin by location; the matched state agrees with the plant file for all 9 plants.</dd>
    <dt>Measure</dt><dd>Water withdrawn as a share of renewable supply, in Aqueduct's five categories: Low (under 10%), Low-medium (10–20%), Medium-high (20–40%), High (40–80%), Extremely high (over 80%).</dd>
    <dt>Today / 2040 view</dt><dd>Aqueduct baseline (1979–2019 hydrology) / Aqueduct's 2015–2045 projection, which contains our whole 2030–2045 window, pessimistic scenario (SSP5-8.5) to match the heat data. Other scenarios and 2035–2065 are on each plant page.</dd>
    <dt>Rating <em class="k k-a">assumption</em></dt><dd>High = Aqueduct High or Extremely high. Medium = Medium-high. Low = below.</dd>
    <dt>Caveat</dt><dd>WRI describes Aqueduct as a prioritisation tool to be followed by local study. Basin stress is not the same as a plant's supply security; Mundra's desalination plant is an example.</dd></dl></section>

  <section class="card"><h2>Heat · rated</h2><dl>
    <dt>Source</dt><dd>Open-Meteo Climate API ${ref("openmeteo")}: 7 high-resolution CMIP6 models (${m.models.map(esc).join(", ")}), downscaled to about 10 km and bias-corrected against ERA5-Land. Daily maximum temperature at each plant.</dd>
    <dt>Measure</dt><dd>Days a year at or above IMD's heatwave threshold ${ref("imd_heat")}: ${m.heat_threshold_c.inland}°C on the plains, ${m.heat_threshold_c.coastal}°C at coastal stations (Mundra, Paradip).</dd>
    <dt>Periods and scenario</dt><dd>2010–2025 vs 2030–2045, equal 16-year windows of model years. One high-emissions pathway, used as a stress test; scenarios differ mainly after 2040 ${ref("ipcc")}.</dd>
    <dt>Rating <em class="k k-a">assumption</em></dt><dd>Median of 7 models. Low under ${d.heat_medium_days} days, Medium ${d.heat_medium_days}–${d.heat_high_days}, High over ${d.heat_high_days}. Fixed before any indicator was calculated.</dd>
    <dt>Agreement</dt><dd>Each plant shows how many models move each way. Fewer than 5 of 7 agreeing reads "models disagree on direction".</dd>
    <dt>Supply links</dt><dd>Not applied to heat: it is high at most plants, so the rule would rate every plant High and hide the differences.</dd></dl></section>

  <section class="card"><h2>Heavy rain · shown, not rated</h2><dl>
    <dt>Measure</dt><dd>Days a year with ${m.heavy_rain_mm} mm or more, IMD's "heavy rainfall" ${ref("imd_rain")}.</dd>
    <dt>Why not rated</dt><dd>A check of record values found ${m.rain_quality.implausible_days} model-days above ${m.rain_quality.implausible_threshold_mm} mm across the 9 plants, up to ${m.rain_quality.max_day_mm.toLocaleString("en-IN")} mm in a day, which is physically implausible here${m.rain_validation && m.rain_validation.imd_max_day_mm ? `: IMD's wettest recorded day at these plants in ${m.rain_validation.years} was ${m.rain_validation.imd_max_day_mm} mm` : ""}. The models also disagree about tenfold on how often heavy rain falls.</dd>
    ${m.rain_validation ? `<dt>IMD check</dt><dd>Each model's ${m.rain_validation.years} rainfall was compared with IMD's 0.25° gridded observations ${ref("imd_grid")} at each plant, on long-run statistics (models do not reproduce real dates). The rule was fixed before seeing the data: heavy-rain days within ±50% (or within 1 day where IMD has fewer than 2) and annual rainfall within ±20%; a model is trusted if it passes at 7 or more of 9 plants. <strong>No model is trusted</strong> (best: ${Object.entries(m.rain_validation.plants_passed).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${esc(k)} ${v} of 9`).join(", ")}). The models also underestimate annual rainfall at some plants, by about half at Mundra.</dd>
    <dt>Next step</dt><dd>Rate rain only from a source that passes the same IMD check.</dd>` : `<dt>Next step</dt><dd>Compare each model's rainfall with IMD's gridded observations ${ref("imd_grid")}; rate rain using only the models that pass.</dd>`}</dl></section>

  <section class="card"><h2>Coastal storm and river flood · flags, current only</h2><dl>
    <dt>Coastal storm</dt><dd>Mundra and Paradip, the two coastal plants: official cyclone-proneness, named past cyclones and Aqueduct coastal flood risk.</dd>
    <dt>River flood</dt><dd>Plants where Aqueduct riverine flood risk is High: Ariyalur, Paradip, Durgapur.</dd>
    <dt>Why flags</dt><dd>No reliable free projection to 2040 exists for these hazards, so they are context, not part of the headline.</dd></dl></section>

  <section class="card"><h2>Supply-link rule <em class="k k-a">assumption</em></h2><dl>
    <dt>Rule</dt><dd>A grinding unit's water rating is the worse of its own and its clinker supplier's: Mundra ← Chittorgarh; Paradip and Durgapur ← Baloda Bazar. Links from the plant file, where shipped and received clinker balance exactly.</dd>
    <dt>Limits</dt><dd>Ignores clinker stock buffers and other suppliers, which the plant file does not include.</dd></dl></section>

  <section class="card"><h2>Known limitations</h2><ul>
    <li>Single emissions scenario for heat and rain.</li>
    <li>"Today" for heat is modelled 2010–2025 climate, not observed weather; for water it is Aqueduct's 1979–2019 baseline.</li>
    <li>The 2030–2045 window is centred on about 2038.</li>
    <li>Threshold days are not IMD-declared heatwave days. Humid heat is not covered, which understates risk at coastal and eastern plants.</li>
    <li>Ratings depend on our thresholds; changing them under Assumptions marks the whole view as non-standard.</li></ul></section>

  <section class="card"><h2>References</h2>
    <ol class="refs">${refs}</ol>
    <h3 style="margin-top:14px">Cyclone and storm records</h3>
    <ul>${events}</ul>
    <p class="small muted" style="margin:10px 0 0">Licences: Open-Meteo CMIP6 data CC BY 4.0 (attribution to CMIP6 and Open-Meteo); WRI Aqueduct 4.0 Creative Commons with attribution to WRI; Natural Earth public domain. Plant data: Nimbus Cement Ltd (fictional, supplied by Oren).</p>
  </section>
  </div>`;
}

/* ---------- Assumptions drawer ---------- */
function openDrawer() {
  const s = S.settings;
  $("#heat-medium").value = s.heat_medium_days; $("#heat-high").value = s.heat_high_days; $("#water-high").value = s.water_high_from;
  $("#form-error").classList.remove("show");
  document.body.classList.add("drawer-open"); $("#drawer").setAttribute("aria-hidden", "false"); $("#heat-medium").focus();
}
function closeDrawer() { document.body.classList.remove("drawer-open"); $("#drawer").setAttribute("aria-hidden", "true"); $("#open-assumptions").focus(); }
function applyDrawer() {
  const mRaw = $("#heat-medium").value.trim(), hRaw = $("#heat-high").value.trim();
  const s = { heat_medium_days: Number(mRaw), heat_high_days: Number(hRaw), water_high_from: $("#water-high").value };
  const err = $("#form-error");
  if (mRaw === "" || hRaw === "" || !Number.isInteger(s.heat_medium_days) || !Number.isInteger(s.heat_high_days)) { err.textContent = "Enter whole numbers of days for both heat thresholds."; err.classList.add("show"); return; }
  if (!validSettings(s)) { err.textContent = "Heat thresholds must be between 0 and 365, and High must be at least the Medium value."; err.classList.add("show"); return; }
  err.classList.remove("show");
  saveSettings(s); closeDrawer();
}
function resetDefaults() { saveSettings(Object.assign({}, S.data.defaults)); if (document.body.classList.contains("drawer-open")) openDrawer(); }

/* ---------- Boot ---------- */
async function boot() {
  const app = $("#app");
  try {
    const get = name => fetch(name, { cache: "no-cache" }).then(r => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); });
    const [d, m] = await Promise.all([get("data.json"), get("map.json")]);
    if (!d.plants || d.plants.length === 0) {
      app.innerHTML = `<div class="state"><h2>No plants to show</h2><p class="muted">The data file loaded but contains no plants. Check the pipeline output.</p></div>`;
      return;
    }
    S.data = d; S.map = m; S.settings = loadSettings();
    document.body.classList.toggle("custom", isCustom());
    route();
  } catch (e) {
    app.innerHTML = `<div class="state"><h2>The exposure data could not be loaded</h2>
      <p class="muted">Nothing is shown rather than an incomplete picture. ${esc(e.message || e)}</p>
      <button class="btn primary" type="button" id="retry">Try again</button></div>`;
    $("#retry").addEventListener("click", () => location.reload());
  }
}
window.addEventListener("hashchange", route);
$("#open-assumptions").addEventListener("click", openDrawer);
$("#close-assumptions").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
$("#apply-assumptions").addEventListener("click", applyDrawer);
$("#reset-assumptions").addEventListener("click", resetDefaults);
$("#banner-reset").addEventListener("click", resetDefaults);
document.addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("drawer-open")) closeDrawer(); });
boot();
