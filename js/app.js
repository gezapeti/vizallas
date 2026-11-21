// Vízállás dashboard – pulls the static JSON emitted by fetch.py and draws charts.
const PALETTE = ["#38b6ff", "#ffb454", "#2ec78a", "#ff6b6b", "#c792ea",
                 "#f78fb3", "#7ee787", "#ffd866", "#79c0ff", "#ff9580"];

// Ordered MM-DD labels for a non-leap year (02-29 dropped for a stable x-axis).
const DAYS = (() => {
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const out = [];
  for (let m = 0; m < 12; m++)
    for (let d = 1; d <= dim[m]; d++)
      out.push(`${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  return out;
})();
const MONTH_TICKS = ["01-01","02-01","03-01","04-01","05-01","06-01",
                     "07-01","08-01","09-01","10-01","11-01","12-01"];

const archiveCache = {};
async function loadArchive(code) {
  if (!archiveCache[code]) {
    const r = await fetch(`data/archive/${code}.json`);
    archiveCache[code] = await r.json();
  }
  return archiveCache[code];
}
const seriesToData = (series) => DAYS.map((d) => (d in series ? series[d] : null));

let META, CURRENT;

async function init() {
  [META, CURRENT] = await Promise.all([
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/current.json").then((r) => r.json()),
  ]);

  const win = META.window;
  document.getElementById("meta-line").innerHTML =
    `Today: <b>${CURRENT.date}</b> · archive window ${win.start}–${win.end} · ` +
    `rebuilt ${META.generated.replace("T", " ").replace("+00:00", "Z")}`;

  renderTodayCards();
  setupExplorer();
  setupCompare();
}

function renderTodayCards() {
  const host = document.getElementById("today-cards");
  host.innerHTML = "";
  for (const s of CURRENT.stations) {
    const h = s.historical;
    let body;
    if (s.level != null) {
      const c = s.change;
      const cls = c > 0 ? "up" : c < 0 ? "down" : "flat";
      const arrow = c > 0 ? "▲" : c < 0 ? "▼" : "▬";
      const sign = c > 0 ? "+" : "";
      body = `<div class="level">${s.level}<span class="unit"> cm</span></div>
              <div class="chg ${cls}">${arrow} ${sign}${c ?? 0} cm / 24h</div>`;
    } else {
      body = `<div class="nolive">no live feed</div>`;
    }
    let gauge = "";
    if (h) {
      const span = Math.max(h.max - h.min, 1);
      const pct = (v) => Math.min(100, Math.max(0, ((v - h.min) / span) * 100));
      const nowMark = s.level != null
        ? `<div class="now" style="left:${pct(s.level)}%" title="today ${s.level} cm"></div>` : "";
      gauge = `<div class="gauge">
          <div class="track">
            <div class="median" style="left:${pct(h.median)}%" title="median ${h.median} cm"></div>
            ${nowMark}
          </div>
          <div class="scale"><span>${h.min}</span><span>median ${h.median}</span><span>${h.max}</span></div>
        </div>`;
    }
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<h3>${s.name}</h3><div class="water">${s.water}</div>${body}${gauge}`;
    host.appendChild(div);
  }
}

function chipRow(host, items, initialOn, onChange) {
  host.innerHTML = "";
  const state = new Map();
  items.forEach((it, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = it.label;
    const on = initialOn(it, i);
    state.set(it.value, on);
    paint(chip, on, it.color);
    chip.onclick = () => {
      const v = !state.get(it.value);
      state.set(it.value, v);
      paint(chip, v, it.color);
      onChange([...state.entries()].filter(([, o]) => o).map(([k]) => k));
    };
    host.appendChild(chip);
  });
  onChange([...state.entries()].filter(([, o]) => o).map(([k]) => k));
  function paint(el, on, color) {
    el.classList.toggle("on", on);
    el.style.background = on ? color : "";
    el.style.borderColor = on ? color : "";
  }
}

const baseChartOpts = (yTitle) => ({
  responsive: true,
  interaction: { mode: "index", intersect: false },
  scales: {
    x: { type: "category", labels: DAYS,
         ticks: { color: "#93a4b5", autoSkip: false,
                  callback: (v, i) => (MONTH_TICKS.includes(DAYS[i]) ? DAYS[i].slice(0, 2) : "") },
         grid: { color: "rgba(147,164,181,.08)" } },
    y: { title: { display: true, text: yTitle, color: "#93a4b5" },
         ticks: { color: "#93a4b5" }, grid: { color: "rgba(147,164,181,.08)" } },
  },
  plugins: {
    legend: { labels: { color: "#e7eef5", usePointStyle: true,
      filter: (it) => !it.text.startsWith("_") } },
  },
});

// ---- One station, year by year ----
let explorerChart;
async function setupExplorer() {
  const sel = document.getElementById("explorer-station");
  sel.innerHTML = META.stations.map((s) => `<option value="${s.code}">${s.name}</option>`).join("");
  sel.onchange = () => drawExplorer(sel.value);
  drawExplorer(sel.value);
}

async function drawExplorer(code) {
  const a = await loadArchive(code);
  const years = Object.keys(a.years).sort();
  const toggles = document.getElementById("explorer-years");
  const items = years.map((y, i) => ({ value: y, label: y, color: PALETTE[i % PALETTE.length] }));
  // Default: show the five most recent years — anomaly lines stay readable overlaid.
  chipRow(toggles, items, (_it, i) => i >= years.length - 5, (onYears) =>
    renderExplorer(code, a, onYears));
}

// Anomaly view: each year plotted as (daily level − historical median for that day).
function renderExplorer(code, a, onYears) {
  const years = Object.keys(a.years).sort();
  const stats = a.doy_stats;
  const anomaly = (series) =>
    DAYS.map((d) => (d in series && stats[d] ? series[d] - stats[d].median : null));

  const datasets = [
    // Faint envelope: full historical range expressed as deviation from the median.
    { label: "_max", data: DAYS.map((d) => (stats[d] ? stats[d].max - stats[d].median : null)),
      borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(147,164,181,.12)", fill: "+1", order: 99 },
    { label: "_min", data: DAYS.map((d) => (stats[d] ? stats[d].min - stats[d].median : null)),
      borderWidth: 0, pointRadius: 0, fill: false, order: 99 },
    // The median itself is the zero baseline.
    { label: "median", data: DAYS.map(() => 0), borderColor: "#93a4b5", borderDash: [5, 4],
      borderWidth: 1.5, pointRadius: 0, fill: false, order: 50 },
  ];
  onYears.sort().forEach((y) => {
    const i = years.indexOf(y);
    datasets.push({ label: y, data: anomaly(a.years[y]), borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 2, pointRadius: 0, spanGaps: true, tension: 0.2 });
  });

  const opts = baseChartOpts("deviation from median (cm)");
  opts.plugins.tooltip = {
    callbacks: {
      label: (c) => {
        if (c.dataset.label.startsWith("_") || c.dataset.label === "median") return null;
        const v = c.parsed.y;
        return `${c.dataset.label}: ${v > 0 ? "+" : ""}${Math.round(v)} cm vs median`;
      },
    },
  };
  if (explorerChart) explorerChart.destroy();
  explorerChart = new Chart(document.getElementById("explorer-chart"),
    { type: "line", data: { labels: DAYS, datasets }, options: opts });
}

// ---- Compare stations ----
let compareChart;
function setupCompare() {
  const allYears = new Set();
  META.stations.forEach((s) => s.years_loaded.forEach((y) => allYears.add(y)));
  const years = [...allYears].sort();
  const ysel = document.getElementById("compare-year");
  ysel.innerHTML = `<option value="median">long-run median</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join("");
  ysel.onchange = redraw;

  const items = META.stations.map((s, i) => ({ value: s.code, label: s.name,
    color: PALETTE[i % PALETTE.length] }));
  let chosen = [];
  chipRow(document.getElementById("compare-stations"), items,
    (it) => ["bp", "se"].includes(it.value), (on) => { chosen = on; redraw(); });

  async function redraw() {
    const year = ysel.value;
    const datasets = [];
    for (const code of chosen) {
      const a = await loadArchive(code);
      const i = META.stations.findIndex((s) => s.code === code);
      const color = PALETTE[i % PALETTE.length];
      let data, label = a.name;
      if (year === "median") {
        data = DAYS.map((d) => (a.doy_stats[d] ? a.doy_stats[d].median : null));
        label += " (median)";
      } else if (a.years[year]) {
        data = seriesToData(a.years[year]);
        label += ` (${year})`;
      } else continue;
      datasets.push({ label, data, borderColor: color, borderWidth: 2,
        pointRadius: 0, spanGaps: true, tension: 0.2 });
    }
    if (compareChart) compareChart.destroy();
    compareChart = new Chart(document.getElementById("compare-chart"),
      { type: "line", data: { labels: DAYS, datasets }, options: baseChartOpts("water level (cm)") });
  }
}

init();
