// Strata desktop front end. Plain JS: views, the sidebar list, notes,
// the graph, the quick switcher and drag-and-drop "which app is this?".
"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const KINDS = [
  ["program", "Program"],
  ["data", "Data"],
  ["cache", "Cache"],
  ["logs", "Logs"],
  ["crash", "Crash dumps"],
  ["temp", "Temp"],
];
const DEV_LABELS = {
  "rust-target": "Rust build output",
  "node-modules": "node_modules",
  "python-venv": "Python virtual env",
  "gradle-build": "Gradle build output",
  "framework-cache": "Framework cache",
  "global-cache": "Download cache",
  toolchain: "Toolchain / SDK",
  "virtual-disk": "Virtual disk",
};
const SAFETY = {
  safe: ["Safe to empty", "ok"],
  "use-windows-tool": ["Use the Windows tool", ""],
  keep: ["Keep", "mute"],
};
const VIEWS = {
  apps: "Apps",
  unclaimed: "Unclaimed",
  dev: "Developer clutter",
  system: "Hidden Windows space",
  graph: "Graph",
};

const state = {
  view: "apps",
  inv: null,
  dev: null,
  sys: null,
  drives: [],
  sel: {},
  filter: "",
  sort: "size",
  scanning: false,
  progress: "",
  firstRender: {},
};

// ------------------------------------------------------------- helpers

function human(b) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${b} B`;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
const reclaim = (t) => t.by_kind.cache + t.by_kind.logs + t.by_kind.crash + t.by_kind.temp;
const leaf = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop();
function ago(secs) {
  if (!secs) return "—";
  const d = Math.floor((Date.now() / 1000 - secs) / 86400);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}
const fmt = (n) => n.toLocaleString("en-US");

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { return null; }
}

let toastTimer;
function toast(html, ms = 3200) {
  const t = $("#toast");
  t.innerHTML = html;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/** Count a number up to its value: sizes feel alive without being slow. */
function countUp(el, to, formatter = human, ms = 450) {
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = formatter(Math.round(to * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Widths set after layout, so bars grow from zero. */
function growBars(root) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = el.dataset.w + "%")),
    ),
  );
}

const ICON = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

// ---------------------------------------------------------------- data

async function loadInventory(rescan) {
  state.scanning = true;
  state.progress = "Scanning";
  $("#btn-rescan").classList.add("spinning");
  renderStatus();
  if (!state.inv) render();
  const t0 = performance.now();
  try {
    const [inv, drives] = await Promise.all([invoke("inventory", { rescan }), invoke("list_drives")]);
    state.inv = inv;
    state.drives = drives;
    if (rescan) {
      state.dev = null;
      state.sys = null;
      toast(`Rescanned in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
  } catch (e) {
    toast(`Scan failed: ${esc(e)}`, 6000);
  } finally {
    state.scanning = false;
    $("#btn-rescan").classList.remove("spinning");
    render();
  }
}

async function ensureView(view) {
  if (view === "dev" && !state.dev) {
    state.progress = "Looking for build output and caches";
    state.scanning = true;
    renderStatus();
    try { state.dev = await invoke("dev_items"); } catch (e) { toast(esc(e)); state.dev = { projects: [], global: [] }; }
    state.scanning = false;
  }
  if (view === "system" && !state.sys) {
    state.progress = "Measuring Windows folders";
    state.scanning = true;
    renderStatus();
    try { state.sys = await invoke("system_items"); } catch (e) { toast(esc(e)); state.sys = []; }
    state.scanning = false;
  }
}

// --------------------------------------------------------------- items

/** The sidebar's rows for the current view. */
function items() {
  const inv = state.inv;
  if (!inv) return [];
  switch (state.view) {
    case "apps":
      return inv.apps.map((a) => ({
        id: a.app.id,
        title: a.app.name,
        size: a.totals.allocated,
        rec: reclaim(a.totals),
        sub: a.parts.length > 1 ? `${a.parts.length} places` : a.parts[0]?.location ?? "",
        search: `${a.app.name} ${a.app.publisher ?? ""}`,
      }));
    case "unclaimed":
      return inv.unclaimed.map((u) => ({
        id: u.path,
        title: leaf(u.path),
        size: u.totals.allocated,
        rec: 0,
        sub: u.hint ?? u.location,
        badge: u.possible_leftover ? ["leftover?", ""] : null,
        search: `${u.path} ${u.hint ?? ""}`,
      }));
    case "dev": {
      if (!state.dev) return [];
      const all = [...state.dev.projects, ...state.dev.global];
      return all.map((d) => ({
        id: d.path,
        title: d.project ? leaf(d.project) : leaf(d.path),
        size: d.totals.allocated,
        rec: d.reclaim === "rebuildable" ? d.totals.allocated : 0,
        sub: DEV_LABELS[d.kind] ?? d.kind,
        search: `${d.path} ${DEV_LABELS[d.kind] ?? ""}`,
      }));
    }
    case "system":
      return (state.sys ?? [])
        .filter((s) => s.totals.allocated > 0 || s.partial)
        .map((s) => ({
          id: s.name,
          title: s.name,
          size: s.totals.allocated,
          rec: s.safety === "safe" ? s.totals.allocated : 0,
          sub: SAFETY[s.safety][0],
          badge: s.partial ? ["admin", "mute"] : null,
          search: `${s.name} ${s.what}`,
        }));
    default:
      return [];
  }
}

function sortedFiltered() {
  const q = state.filter.trim().toLowerCase();
  let list = items();
  if (q) list = list.filter((i) => i.search.toLowerCase().includes(q));
  const by = {
    size: (a, b) => b.size - a.size,
    name: (a, b) => a.title.localeCompare(b.title),
    reclaimable: (a, b) => b.rec - a.rec,
  }[state.sort];
  return list.sort(by);
}

// ------------------------------------------------------------- sidebar

let pill;
function renderList() {
  const listEl = $("#list");
  const showList = state.view !== "graph";
  $("#sidebar").style.display = showList ? "" : "none";
  $("#resizer").style.display = showList ? "" : "none";
  if (!showList) return;

  $("#side-title").textContent = VIEWS[state.view];
  const rows = sortedFiltered();
  $("#side-count").textContent = state.inv ? fmt(rows.length) : "";
  const max = rows.reduce((m, r) => Math.max(m, r.size), 1);
  const animate = !state.firstRender[state.view];
  state.firstRender[state.view] = true;

  if (!state.inv || (state.view === "dev" && !state.dev) || (state.view === "system" && !state.sys)) {
    listEl.innerHTML = Array.from({ length: 12 }, () => '<div class="skeleton"></div>').join("");
    return;
  }
  if (!rows.length) {
    listEl.innerHTML = `<div class="empty-list">${state.filter ? "Nothing matches the filter." : "Nothing here."}</div>`;
    return;
  }
  listEl.innerHTML =
    '<div class="pill" id="pill"></div>' +
    rows
      .map((r, i) => {
        const delay = animate ? `animation-delay:${Math.min(i * 12, 320)}ms` : "animation:none";
        const badge = r.badge ? `<span class="badge ${r.badge[1]}">${esc(r.badge[0])}</span>` : "";
        const shown = state.sort === "reclaimable" ? r.rec : r.size;
        return `<div class="row" data-id="${esc(r.id)}" style="${delay}">
          <span class="t">${esc(r.title)}${badge}</span><span class="s">${human(shown)}</span>
          <span class="sub">${esc(r.sub)}</span>
          <span class="meter"><i style="width:${Math.max(1.5, (r.size / max) * 100)}%;${animate ? "" : "animation:none"}"></i></span>
        </div>`;
      })
      .join("");
  pill = $("#pill");
  movePill(false);
}

/** Slide the selection highlight to the selected row. */
function movePill(smooth = true) {
  if (!pill) return;
  const id = state.sel[state.view];
  const listEl = $("#list");
  listEl.querySelectorAll(".row.selected").forEach((r) => r.classList.remove("selected"));
  const row = id != null ? listEl.querySelector(`.row[data-id="${CSS.escape(id)}"]`) : null;
  if (!row) {
    pill.style.opacity = 0;
    return;
  }
  row.classList.add("selected");
  if (!smooth) pill.style.transition = "none";
  pill.style.opacity = 1;
  pill.style.transform = `translateY(${row.offsetTop}px)`;
  pill.style.height = row.offsetHeight + "px";
  if (!smooth) requestAnimationFrame(() => (pill.style.transition = ""));
  const top = row.offsetTop, bottom = top + row.offsetHeight;
  if (top < listEl.scrollTop) listEl.scrollTo({ top: top - 8, behavior: smooth ? "smooth" : "auto" });
  else if (bottom > listEl.scrollTop + listEl.clientHeight)
    listEl.scrollTo({ top: bottom - listEl.clientHeight + 8, behavior: smooth ? "smooth" : "auto" });
}

function select(id, opts = {}) {
  state.sel[state.view] = id;
  movePill(true);
  renderMain(opts);
}

// ---------------------------------------------------------------- main

function renderMain(opts = {}) {
  const main = $("#main");
  stopGraph();
  if (!state.inv) {
    main.innerHTML = `<div class="loading"><div class="box">
      <div class="strata-mark"><i></i><i></i><i></i><i></i></div>
      <div class="msg" id="load-msg">${esc(state.progress || "Scanning")}…</div></div></div>`;
    return;
  }
  if (state.view === "graph") return renderGraph(main);
  if ((state.view === "dev" && !state.dev) || (state.view === "system" && !state.sys)) {
    main.innerHTML = `<article class="note"><h1>${esc(VIEWS[state.view])}</h1>
      <p class="lede">Measuring…</p>${'<div class="skeleton"></div>'.repeat(6)}</article>`;
    return;
  }
  const id = state.sel[state.view];
  const html = {
    apps: () => (id ? appNote(id) : overviewNote()),
    unclaimed: () => (id ? unclaimedNote(id) : unclaimedOverview()),
    dev: () => (id ? devNote(id) : devOverview()),
    system: () => (id ? systemNote(id) : systemOverview()),
  }[state.view]();
  main.innerHTML = html ?? overviewNote();
  main.scrollTop = 0;
  growBars(main);
  main.querySelectorAll("[data-count]").forEach((el) =>
    countUp(el, +el.dataset.count, el.hasAttribute("data-plain") ? fmt : human),
  );
  if (opts.flashPath) {
    const el = main.querySelector(`.part[data-path="${CSS.escape(opts.flashPath)}"]`);
    if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
}

function kindBar(t) {
  const total = Math.max(1, t.allocated);
  const segs = KINDS.filter(([k]) => t.by_kind[k] > 0)
    .map(([k]) => `<span style="background:var(--k-${k})" data-w="${(t.by_kind[k] / total) * 100}"></span>`)
    .join("");
  const legend = KINDS.filter(([k]) => t.by_kind[k] > 0)
    .map(([k, l]) => `<span><i class="dot" style="background:var(--k-${k})"></i>${l}<b>${human(t.by_kind[k])}</b></span>`)
    .join("");
  return `<div class="kbar">${segs}</div><div class="legend">${legend}</div>`;
}

function prop(k, v) {
  return v == null || v === "" ? "" : `<div class="prop"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}

function partRow(p, i, size, where, conf, why) {
  return `<div class="part" data-path="${esc(p)}" style="animation-delay:${Math.min(i * 30, 300)}ms">
    <div class="size">${human(size)}</div>
    <div><div class="where">${esc(where)}${conf ? `<span class="conf ${conf}">${conf}</span>` : ""}</div>
      <div class="path">${esc(p)}</div>${why ? `<div class="why">${esc(why)}</div>` : ""}</div>
    <button class="icon-btn" data-reveal="${esc(p)}" title="Show in Explorer">${ICON.folder}</button>
  </div>`;
}

function appNote(id) {
  const a = state.inv.apps.find((x) => x.app.id === id);
  if (!a) return null;
  const t = a.totals;
  const src = { steam: "Steam", epic: "Epic Games", registry: "Installed program", store: "Microsoft Store" }[a.app.source];
  return `<article class="note">
    <h1>${esc(a.app.name)}</h1>
    <p class="lede">${a.parts.length} ${a.parts.length === 1 ? "place" : "places"} on disk, ${fmt(t.files)} files</p>
    <div class="big" data-count="${t.allocated}">0 B</div>
    <div class="props">
      ${prop("Reclaimable", `${human(reclaim(t))} <span class="conf">cache, logs, crash dumps, temp</span>`)}
      ${prop("Publisher", esc(a.app.publisher))}
      ${prop("Version", esc(a.app.version))}
      ${prop("Source", esc(src))}
      ${prop("Installer says", a.app.reported_bytes ? `${human(a.app.reported_bytes)} <span class="conf">install folder only</span>` : null)}
      ${prop("Last changed", ago(t.newest))}
      ${t.cloud_only ? prop("Cloud-only files", fmt(t.cloud_only)) : ""}
    </div>
    <h2>What it is</h2>${kindBar(t)}
    <h2>Where it lives</h2>
    <div class="parts">${a.parts
      .map((p, i) => partRow(p.path, i, p.totals.allocated, p.location, p.confidence, p.reason))
      .join("")}</div>
  </article>`;
}

function overviewNote() {
  const inv = state.inv;
  const appsTotal = inv.apps.reduce((s, a) => s + a.totals.allocated, 0);
  const rec = inv.apps.reduce((s, a) => s + reclaim(a.totals), 0);
  const unc = inv.unclaimed.reduce((s, u) => s + u.totals.allocated, 0);
  const drives = state.drives
    .map((d) => {
      const used = d.total - d.free, pct = d.total ? (used / d.total) * 100 : 0;
      return `<div class="drive"><div class="head"><span>${esc(d.root)}</span>
        <span>${human(d.free)} free of ${human(d.total)}</span></div>
        <div class="track"><i class="${pct > 88 ? "hot" : ""}" data-w="${pct}"></i></div></div>`;
    })
    .join("");
  const top = inv.apps.slice(0, 12);
  const max = Math.max(1, top[0]?.totals.allocated ?? 1);
  const bars = top
    .map((a, i) => `<div class="hbar" data-open-app="${esc(a.app.id)}" style="animation-delay:${i * 25}ms">
      <span class="n">${esc(a.app.name)}</span><div class="track"><i data-w="${(a.totals.allocated / max) * 100}"></i></div>
      <span class="v">${human(a.totals.allocated)}</span></div>`)
    .join("");
  // Bytes by where they live, across every app.
  const byLoc = {};
  for (const a of inv.apps) for (const p of a.parts) {
    const k = p.location.split("\\").slice(0, 2).join("\\");
    byLoc[k] = (byLoc[k] ?? 0) + p.totals.allocated;
  }
  const locs = Object.entries(byLoc).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const lmax = Math.max(1, locs[0]?.[1] ?? 1);
  const locBars = locs
    .map(([k, v], i) => `<div class="hbar" style="cursor:default;animation-delay:${i * 25}ms"><span class="n">${esc(k)}</span>
      <div class="track"><i data-w="${(v / lmax) * 100}"></i></div><span class="v">${human(v)}</span></div>`)
    .join("");
  return `<article class="note">
    <h1>Your disk</h1>
    <p class="lede">Every app's files, wherever they are, added up.</p>
    ${drives}
    <div class="cards" style="margin-top:20px">
      <div class="card"><div class="label">Apps</div><div class="value" data-count="${inv.apps.length}" data-plain>0</div></div>
      <div class="card"><div class="label">Used by apps</div><div class="value" data-count="${appsTotal}">0 B</div></div>
      <div class="card"><div class="label">Reclaimable</div><div class="value" data-count="${rec}">0 B</div></div>
      <div class="card" data-goto="unclaimed" style="cursor:pointer"><div class="label">Unclaimed folders</div><div class="value" data-count="${unc}">0 B</div></div>
    </div>
    <h2>Biggest apps</h2><div class="bars">${bars}</div>
    <h2>Where app files live</h2><div class="bars">${locBars}</div>
    <div class="callout">Drop any file or folder on this window to see which app it belongs to. <kbd>Ctrl P</kbd> finds anything.</div>
  </article>`;
}

function unclaimedNote(id) {
  const u = state.inv.unclaimed.find((x) => x.path === id);
  if (!u) return null;
  return `<article class="note">
    <h1>${esc(leaf(u.path))}${u.possible_leftover ? '<span class="badge">possible leftover</span>' : ""}</h1>
    <p class="lede">No installed app claims this folder.</p>
    <div class="big" data-count="${u.totals.allocated}">0 B</div>
    <div class="props">
      ${prop("What it probably is", esc(u.hint ?? "Unknown"))}
      ${prop("Location", esc(u.location))}
      ${prop("Files", fmt(u.totals.files))}
      ${prop("Last changed", ago(u.totals.newest))}
    </div>
    <h2>What it is</h2>${kindBar(u.totals)}
    <h2>Folder</h2><div class="parts">${partRow(u.path, 0, u.totals.allocated, u.location)}</div>
    ${u.possible_leftover ? '<div class="callout">Nothing has changed here for six months and no installed app matches it: it is probably left over from an app you uninstalled. Check it in Explorer before removing it.</div>' : ""}
  </article>`;
}

function unclaimedOverview() {
  const list = state.inv.unclaimed;
  const total = list.reduce((s, u) => s + u.totals.allocated, 0);
  const left = list.filter((u) => u.possible_leftover);
  const leftTotal = left.reduce((s, u) => s + u.totals.allocated, 0);
  return `<article class="note"><h1>Unclaimed</h1>
    <p class="lede">Folders in the usual app places that no installed app claims.</p>
    <div class="cards">
      <div class="card"><div class="label">Unclaimed</div><div class="value" data-count="${total}">0 B</div></div>
      <div class="card"><div class="label">Possible leftovers</div><div class="value" data-count="${leftTotal}">0 B</div></div>
    </div>
    <div class="callout">Possible leftovers are unclaimed, not a known shared folder, and untouched for six months. Strata never deletes anything: check a folder before removing it yourself.</div>
  </article>`;
}

function devItem(id) {
  return [...state.dev.projects, ...state.dev.global].find((d) => d.path === id);
}

function noteHtml(note) {
  return esc(note).replace(/`([^`]+)`/g, "<code>$1</code>");
}

function devNote(id) {
  const d = devItem(id);
  if (!d) return null;
  const cmd = (d.note.match(/`([^`]+)`/) ?? [])[1];
  return `<article class="note">
    <h1>${esc(d.project ? leaf(d.project) : leaf(d.path))}</h1>
    <p class="lede">${esc(DEV_LABELS[d.kind] ?? d.kind)}</p>
    <div class="big" data-count="${d.totals.allocated}">0 B</div>
    <div class="props">
      ${prop("Project", d.project ? esc(d.project) : null)}
      ${prop("Safe to delete", d.reclaim === "rebuildable" ? "Yes: it comes back on the next build or install" : "Use the tool that owns it")}
      ${prop("Last touched", ago(d.totals.newest))}
      ${prop("Files", fmt(d.totals.files))}
    </div>
    <div class="callout">${noteHtml(d.note)}
      ${cmd ? `<button class="chip-btn" data-copy="${esc(cmd)}" style="margin-left:8px;height:24px">Copy command</button>` : ""}</div>
    <h2>Folder</h2><div class="parts">${partRow(d.path, 0, d.totals.allocated, DEV_LABELS[d.kind] ?? "")}</div>
  </article>`;
}

function devOverview() {
  const p = state.dev.projects.reduce((s, d) => s + d.totals.allocated, 0);
  const g = state.dev.global.reduce((s, d) => s + d.totals.allocated, 0);
  return `<article class="note"><h1>Developer clutter</h1>
    <p class="lede">Build output and dependencies in your projects, and the caches and toolchains behind them.</p>
    <div class="cards">
      <div class="card"><div class="label">In projects</div><div class="value" data-count="${p}">0 B</div></div>
      <div class="card"><div class="label">Caches, SDKs, dev disks</div><div class="value" data-count="${g}">0 B</div></div>
    </div>
    <div class="callout">Projects are looked for in your user folder and <code>C:\\projects</code>.</div></article>`;
}

function systemNote(id) {
  const s = (state.sys ?? []).find((x) => x.name === id);
  if (!s) return null;
  const [label, cls] = SAFETY[s.safety];
  return `<article class="note">
    <h1>${esc(s.name)}<span class="badge ${cls}">${esc(label)}</span></h1>
    <p class="lede">${esc(s.what)}</p>
    <div class="big" data-count="${s.totals.allocated}">0 B</div>
    ${s.partial ? '<p class="lede">Part of it needs administrator rights to read, so the real size is bigger.</p>' : ""}
    <div class="callout">${noteHtml(s.how)}</div>
    <h2>Location</h2><div class="parts">${partRow(s.path, 0, s.totals.allocated, s.name)}</div>
  </article>`;
}

function systemOverview() {
  const all = state.sys ?? [];
  const total = all.reduce((s, x) => s + x.totals.allocated, 0);
  const safe = all.filter((x) => x.safety === "safe").reduce((s, x) => s + x.totals.allocated, 0);
  return `<article class="note"><h1>Hidden Windows space</h1>
    <p class="lede">What Windows itself keeps on the disk, and how to shrink it.</p>
    <div class="cards">
      <div class="card"><div class="label">Windows keeps</div><div class="value" data-count="${total}">0 B</div></div>
      <div class="card"><div class="label">Safe to empty</div><div class="value" data-count="${safe}">0 B</div></div>
    </div></article>`;
}

// --------------------------------------------------------------- graph

let graph = null;

function stopGraph() {
  if (graph) {
    cancelAnimationFrame(graph.raf);
    graph.ro.disconnect();
    graph = null;
  }
}

/** Obsidian-style graph: apps linked to the places their files live. */
function renderGraph(main) {
  main.innerHTML = `<div class="graph-wrap"><canvas></canvas>
    <div class="graph-hint">Scroll to zoom · drag to move · click an app to open it</div></div>`;
  const canvas = $("canvas", main);
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const colors = { app: col("--k-data"), hub: col("--accent"), text: col("--text"), muted: col("--faint"), line: col("--border") };

  const nodes = [], links = [], hubs = new Map();
  const apps = state.inv.apps.slice(0, 70);
  const maxSize = Math.max(1, apps[0]?.totals.allocated ?? 1);
  const hubOf = (loc) => {
    const key = loc.split("\\").slice(0, 2).join("\\");
    if (!hubs.has(key)) {
      const n = { id: "hub:" + key, label: key, hub: true, r: 9, x: (Math.random() - 0.5) * 200, y: (Math.random() - 0.5) * 200, vx: 0, vy: 0, a: 1 };
      hubs.set(key, n);
      nodes.push(n);
    }
    return hubs.get(key);
  };
  for (const a of apps) {
    const n = {
      id: a.app.id, label: a.app.name, size: a.totals.allocated,
      r: 3 + Math.sqrt(a.totals.allocated / maxSize) * 16,
      x: (Math.random() - 0.5) * 500, y: (Math.random() - 0.5) * 500, vx: 0, vy: 0, a: 1,
    };
    nodes.push(n);
    const seen = new Set();
    for (const p of a.parts) {
      const h = hubOf(p.location);
      if (seen.has(h)) continue;
      seen.add(h);
      links.push({ s: n, t: h });
    }
  }
  const nbrs = new Map(nodes.map((n) => [n, new Set()]));
  for (const l of links) { nbrs.get(l.s).add(l.t); nbrs.get(l.t).add(l.s); }

  // `auto` keeps the whole graph in view until you zoom or move it.
  const g = (graph = { raf: 0, ro: null, zoom: 0.6, panX: 0, panY: 0, hover: null, drag: null, energy: 1, auto: true });
  let W = 0, H = 0, dpr = 1;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    g.energy = Math.max(g.energy, 0.3);
  };
  g.ro = new ResizeObserver(resize);
  g.ro.observe(canvas);
  resize();

  const toWorld = (mx, my) => [(mx - W / 2 - g.panX) / g.zoom, (my - H / 2 - g.panY) / g.zoom];
  const nodeAt = (mx, my) => {
    const [x, y] = toWorld(mx, my);
    let best = null, bd = Infinity;
    for (const n of nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 4 / g.zoom && d < bd) { best = n; bd = d; }
    }
    return best;
  };

  function tick() {
    if (g.energy > 0.002) {
      const k = 0.6 * g.energy;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy + 0.01;
          const f = (420 * k) / d2;
          dx *= f; dy *= f;
          a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
        }
      }
      for (const l of links) {
        const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
        const d = Math.hypot(dx, dy) || 1;
        const f = ((d - 70) / d) * 0.02 * k * 10;
        l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f * 0.3; l.t.vy -= dy * f * 0.3;
      }
      for (const n of nodes) {
        if (n === g.drag?.node) continue;
        n.vx -= n.x * 0.002 * 10 * k; n.vy -= n.y * 0.002 * 10 * k;
        n.vx *= 0.82; n.vy *= 0.82;
        n.x += n.vx; n.y += n.vy;
      }
      g.energy *= 0.985;
    }
    if (g.auto && nodes.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of nodes) {
        x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r);
        y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r);
      }
      const z = Math.min(1.6, (W - 120) / (x1 - x0 || 1), (H - 100) / (y1 - y0 || 1));
      g.zoom += (z - g.zoom) * 0.08;
      g.panX += (-((x0 + x1) / 2) * g.zoom - g.panX) * 0.08;
      g.panY += (-((y0 + y1) / 2) * g.zoom - g.panY) * 0.08;
    }
    // Hover fades everything but the node and its neighbours.
    const focus = g.hover;
    for (const n of nodes) {
      const target = !focus || n === focus || nbrs.get(focus).has(n) ? 1 : 0.14;
      n.a += (target - n.a) * 0.18;
    }
    draw();
    g.raf = requestAnimationFrame(tick);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2 + g.panX, H / 2 + g.panY);
    ctx.scale(g.zoom, g.zoom);
    ctx.lineWidth = 1 / g.zoom;
    for (const l of links) {
      const on = g.hover && (l.s === g.hover || l.t === g.hover);
      ctx.globalAlpha = Math.min(l.s.a, l.t.a) * (on ? 0.9 : 0.45);
      ctx.strokeStyle = on ? colors.hub : colors.line;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    for (const n of nodes) {
      ctx.globalAlpha = n.a;
      ctx.fillStyle = n.hub ? colors.hub : n === g.hover ? colors.hub : colors.app;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = `${12 / g.zoom}px Segoe UI, system-ui, sans-serif`;
    ctx.textAlign = "center";
    for (const n of nodes) {
      const show = n.hub || n === g.hover || (g.hover && nbrs.get(g.hover).has(n)) || n.r * g.zoom > 9;
      if (!show) continue;
      ctx.globalAlpha = n.a;
      ctx.fillStyle = n.hub ? colors.text : colors.muted;
      const label = n.size ? `${n.label} · ${human(n.size)}` : n.label;
      ctx.fillText(label, n.x, n.y + n.r + 13 / g.zoom);
    }
    ctx.globalAlpha = 1;
  }

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    if (g.drag) {
      if (g.drag.node) {
        const [x, y] = toWorld(mx, my);
        g.drag.node.x = x; g.drag.node.y = y; g.drag.node.vx = g.drag.node.vy = 0;
        g.energy = Math.max(g.energy, 0.25);
      } else {
        g.panX = g.drag.px + (mx - g.drag.mx); g.panY = g.drag.py + (my - g.drag.my);
      }
      g.drag.moved = g.drag.moved || Math.hypot(mx - g.drag.mx, my - g.drag.my) > 3;
      return;
    }
    g.hover = nodeAt(mx, my);
    canvas.style.cursor = g.hover ? "pointer" : "grab";
  });
  canvas.addEventListener("mousedown", (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    g.auto = false;
    g.drag = { node: nodeAt(mx, my), mx, my, px: g.panX, py: g.panY, moved: false };
    canvas.classList.add("dragging");
  });
  window.addEventListener("mouseup", () => {
    if (!graph || graph !== g || !g.drag) return;
    const { node, moved } = g.drag;
    g.drag = null;
    canvas.classList.remove("dragging");
    if (node && !moved && !node.hub) {
      setView("apps");
      select(node.id);
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    g.auto = false;
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - W / 2, my = e.clientY - r.top - H / 2;
    const z = Math.min(4, Math.max(0.25, g.zoom * Math.exp(-e.deltaY * 0.0015)));
    g.panX = mx - ((mx - g.panX) * z) / g.zoom;
    g.panY = my - ((my - g.panY) * z) / g.zoom;
    g.zoom = z;
  }, { passive: false });

  g.raf = requestAnimationFrame(tick);
}

// --------------------------------------------------------------- views

function render() {
  document.querySelectorAll(".rib[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  $("#sort").textContent = state.sort;
  renderList();
  renderMain();
  renderStatus();
}

async function setView(view) {
  if (state.view === view && view !== "graph") return;
  state.view = view;
  state.filter = "";
  $("#filter").value = "";
  render();
  if ((view === "dev" && !state.dev) || (view === "system" && !state.sys)) {
    await ensureView(view);
    if (state.view === view) render();
    else renderStatus();
  }
}

function renderStatus() {
  const left = $("#status-left");
  if (state.scanning) {
    left.innerHTML = `<span class="spinner"></span>${esc(state.progress)}…`;
  } else if (state.inv) {
    const i = state.inv;
    left.textContent = `${fmt(i.apps.length)} apps · ${fmt(i.totals.files)} files · scanned in ${i.scan_seconds.toFixed(1)} s`;
  } else left.textContent = "";
  const c = state.drives.find((d) => /^C:/i.test(d.root)) ?? state.drives[0];
  $("#status-drive").textContent = c ? `${c.root} ${human(c.free)} free` : "";
  const msg = $("#load-msg");
  if (msg) msg.textContent = `${state.progress || "Scanning"}…`;
}

// ------------------------------------------------------------ palette

const pal = { open: false, results: [], active: 0 };

function paletteEntries() {
  const out = [
    { k: "Command", t: "Rescan", run: () => loadInventory(true) },
    { k: "Command", t: "Toggle light / dark theme", run: toggleTheme },
    { k: "Command", t: "Open graph view", run: () => setView("graph") },
    { k: "Command", t: "Show possible leftovers", run: () => setView("unclaimed") },
  ];
  if (!state.inv) return out;
  for (const a of state.inv.apps)
    out.push({ k: "App", t: a.app.name, s: human(a.totals.allocated), run: () => { setView("apps"); select(a.app.id); } });
  for (const u of state.inv.unclaimed)
    out.push({ k: "Folder", t: u.path, s: human(u.totals.allocated), run: () => { setView("unclaimed"); select(u.path); } });
  for (const d of state.dev ? [...state.dev.projects, ...state.dev.global] : [])
    out.push({ k: "Dev", t: d.path, s: human(d.totals.allocated), run: async () => { await setView("dev"); select(d.path); } });
  for (const s of state.sys ?? [])
    out.push({ k: "Windows", t: s.name, s: human(s.totals.allocated), run: async () => { await setView("system"); select(s.name); } });
  return out;
}

/** Subsequence match; earlier and tighter matches score higher. */
function fuzzy(q, text) {
  if (!q) return { score: 0, marks: [] };
  const t = text.toLowerCase();
  let ti = 0, score = 0, last = -1;
  const marks = [];
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === last + 1 ? 3 : 1;
    if (i === 0 || /[\s\\/._-]/.test(t[i - 1])) score += 2;
    marks.push(i);
    last = i;
    ti = i + 1;
  }
  return { score: score - marks[0] * 0.05 - text.length * 0.002, marks };
}

function highlight(text, marks) {
  const set = new Set(marks);
  return [...text].map((c, i) => (set.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join("");
}

function updatePalette() {
  const q = $("#palette-input").value.trim().toLowerCase();
  const scored = [];
  for (const e of paletteEntries()) {
    const m = fuzzy(q, e.t);
    if (m) scored.push({ ...e, ...m });
  }
  if (q) scored.sort((a, b) => b.score - a.score);
  pal.results = scored.slice(0, 40);
  pal.active = 0;
  drawPalette();
}

function drawPalette() {
  $("#palette-results").innerHTML =
    pal.results
      .map((r, i) => `<div class="pr ${i === pal.active ? "active" : ""}" data-i="${i}">
        <span class="k">${esc(r.k)}</span><span class="t">${highlight(r.t, r.marks)}</span><span class="s">${esc(r.s ?? "")}</span></div>`)
      .join("") || '<div class="empty-list">No matches.</div>';
  $("#palette-results .pr.active")?.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  pal.open = true;
  $("#palette").hidden = false;
  const input = $("#palette-input");
  input.value = "";
  updatePalette();
  input.focus();
}
function closePalette() {
  pal.open = false;
  $("#palette").hidden = true;
}
function runPalette(i) {
  const r = pal.results[i];
  closePalette();
  r?.run();
}

// -------------------------------------------------------------- theme

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store("strata.theme", next);
  if (state.view === "graph") renderMain();
}

// ------------------------------------------------------------- events

function wire() {
  document.querySelectorAll(".rib[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  $("#btn-palette").addEventListener("click", openPalette);
  $("#btn-rescan").addEventListener("click", () => !state.scanning && loadInventory(true));
  $("#btn-theme").addEventListener("click", toggleTheme);

  $("#filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderList();
  });
  $("#filter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = sortedFiltered()[0];
      if (first) select(first.id);
    }
  });
  $("#sort").addEventListener("click", () => {
    const order = state.view === "apps" ? ["size", "reclaimable", "name"] : ["size", "name"];
    state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
    $("#sort").textContent = state.sort;
    renderList();
  });

  $("#list").addEventListener("click", (e) => {
    const row = e.target.closest(".row");
    if (row) select(row.dataset.id);
  });

  $("#main").addEventListener("click", async (e) => {
    const rev = e.target.closest("[data-reveal]");
    if (rev) {
      try { await invoke("reveal", { path: rev.dataset.reveal }); } catch (err) { toast(esc(err)); }
      return;
    }
    const cp = e.target.closest("[data-copy]");
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy); toast(`Copied <code>${esc(cp.dataset.copy)}</code>`); }
      catch { toast("Couldn't copy"); }
      return;
    }
    const app = e.target.closest("[data-open-app]");
    if (app) return select(app.dataset.openApp);
    const go = e.target.closest("[data-goto]");
    if (go) return setView(go.dataset.goto);
  });

  $("#palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
  $("#palette-input").addEventListener("input", updatePalette);
  $("#palette-results").addEventListener("mousemove", (e) => {
    const r = e.target.closest(".pr");
    if (r && +r.dataset.i !== pal.active) { pal.active = +r.dataset.i; drawPalette(); }
  });
  $("#palette-results").addEventListener("click", (e) => {
    const r = e.target.closest(".pr");
    if (r) runPalette(+r.dataset.i);
  });

  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (pal.open) {
      if (e.key === "Escape") closePalette();
      else if (e.key === "ArrowDown") { pal.active = Math.min(pal.results.length - 1, pal.active + 1); drawPalette(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { pal.active = Math.max(0, pal.active - 1); drawPalette(); e.preventDefault(); }
      else if (e.key === "Enter") runPalette(pal.active);
      return;
    }
    if (ctrl && ["p", "o", "k"].includes(e.key.toLowerCase())) { e.preventDefault(); openPalette(); return; }
    if (ctrl && e.key.toLowerCase() === "r") { e.preventDefault(); if (!state.scanning) loadInventory(true); return; }
    if (ctrl && e.key.toLowerCase() === "f") { e.preventDefault(); $("#filter").focus(); return; }
    if (ctrl && /^[1-5]$/.test(e.key)) { e.preventDefault(); setView(Object.keys(VIEWS)[+e.key - 1]); return; }
    if (e.key === "Escape") {
      if (document.activeElement === $("#filter")) $("#filter").blur();
      else if (state.sel[state.view]) { state.sel[state.view] = null; movePill(); renderMain(); }
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && state.view !== "graph") {
      const rows = sortedFiltered();
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.findIndex((r) => r.id === state.sel[state.view]);
      const next = e.key === "ArrowDown" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      select(rows[next].id);
    }
  });

  // Sidebar width, remembered.
  const side = $("#sidebar");
  const saved = +store("strata.sidebar");
  if (saved >= 200 && saved <= 520) side.style.width = saved + "px";
  const rz = $("#resizer");
  rz.addEventListener("mousedown", (e) => {
    e.preventDefault();
    rz.classList.add("dragging");
    const x0 = e.clientX, w0 = side.offsetWidth;
    const move = (ev) => (side.style.width = Math.min(520, Math.max(200, w0 + ev.clientX - x0)) + "px");
    const up = () => {
      rz.classList.remove("dragging");
      store("strata.sidebar", side.offsetWidth);
      movePill(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // Drag a file or folder in: which app is it?
  const drop = $("#drop");
  listen("tauri://drag-enter", () => drop.classList.add("show"));
  listen("tauri://drag-leave", () => drop.classList.remove("show"));
  listen("tauri://drag-drop", async (ev) => {
    drop.classList.remove("show");
    const path = ev.payload?.paths?.[0];
    if (!path) return;
    if (!state.inv) return toast("Still scanning: try again in a moment.");
    try {
      const w = await invoke("why", { path });
      if (!w) return toast(`<b>${esc(leaf(path))}</b> is outside the folders Strata maps to apps.`, 5000);
      if (w.app) {
        const a = state.inv.apps.find((x) => x.app.name === w.app);
        await setView("apps");
        if (a) select(a.app.id, { flashPath: w.part });
        toast(`<b>${esc(leaf(path))}</b> belongs to <b>${esc(w.app)}</b>`, 4000);
      } else {
        await setView("unclaimed");
        select(w.part);
        toast(`<b>${esc(leaf(path))}</b> isn't claimed by any installed app`, 4000);
      }
    } catch (err) {
      toast(esc(err));
    }
  });

  listen("scan-progress", (ev) => {
    state.progress = ev.payload;
    renderStatus();
  });
}

// --------------------------------------------------------------- start

document.documentElement.dataset.theme = store("strata.theme") || "dark";
wire();
render();
loadInventory(false);
