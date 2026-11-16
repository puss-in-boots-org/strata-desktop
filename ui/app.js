// Strata desktop front end (0.2). Plain JS, no build step: a sidebar of
// sections, an overview built around a zoomable sunburst of the drive,
// game cards with real art, app pages, folder explorers, search (Ctrl+K)
// and drag-and-drop "what does this belong to?".
"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function human(b) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = b, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${Math.round(b)} B`;
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const sum = (xs, f = (x) => x.size) => xs.reduce((s, x) => s + f(x), 0);
const reclaim = (t) => t.by_kind.cache + t.by_kind.logs + t.by_kind.crash + t.by_kind.temp;
const leaf = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p);
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
function ago(secs) {
  if (!secs) return "—";
  const d = Math.floor((Date.now() / 1000 - secs) / 86400);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}
function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch { return null; }
}

let toastTimer;
function toast(html, ms = 3400) {
  const t = $("#toast");
  t.innerHTML = html;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function countUp(el, to, f = human, ms = 500) {
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    el.textContent = f(to * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Bars get their width after layout, so they grow in. */
function animateIn(root) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.querySelectorAll("[data-w]").forEach((el) => (el.style.width = el.dataset.w + "%"))),
  );
  root.querySelectorAll("[data-count]").forEach((el) =>
    countUp(el, +el.dataset.count, el.hasAttribute("data-plain") ? fmt : human),
  );
  hydrate(root);
}

const ICON = {
  overview: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  code: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
};

// ---------------------------------------------------------------- model

/** Colour and name of each top-level slice of a drive. */
const CATS = {
  games: { label: "Games", hex: "#9d7bff", h: 258, s: 72, l: 70 },
  apps: { label: "Apps", hex: "#4ea8ff", h: 210, s: 82, l: 62 },
  files: { label: "Your files", hex: "#f2b84b", h: 40, s: 84, l: 62 },
  system: { label: "Windows & system", hex: "#8792a6", h: 218, s: 14, l: 62 },
  leftovers: { label: "Leftovers", hex: "#f07167", h: 4, s: 80, l: 66 },
  unreadable: { label: "Not readable", css: "var(--c-unreadable)" },
  free: { label: "Free space", css: "var(--c-free)" },
};
const AREA_CAT = {
  files: "files", "recycle-bin": "files", "other-users": "files",
  windows: "system", programs: "system", "app-data": "system",
};
const SOURCE = { steam: "Steam", epic: "Epic", xbox: "Xbox", minecraft: "Minecraft", registry: "PC", store: "Store" };
const KINDS = [["program", "Program"], ["data", "Data"], ["cache", "Cache"], ["logs", "Logs"], ["crash", "Crash dumps"], ["temp", "Temp"]];
const DEV_LABELS = {
  "rust-target": "Rust build output", "node-modules": "node_modules", "python-venv": "Python virtual env",
  "gradle-build": "Gradle build output", "framework-cache": "Framework cache", "global-cache": "Download cache",
  toolchain: "Toolchain / SDK", "virtual-disk": "Virtual disk",
};
const SAFETY = { safe: ["Safe to empty", "ok"], "use-windows-tool": ["Use the Windows tool", ""], keep: ["Keep", "mute"] };

const state = {
  inv: null, trees: [], drive: 0, apps: new Map(),
  page: "overview", detail: null, flashPath: null, prev: "overview",
  dev: null, sys: null, scanning: false, progress: "", t0: 0,
  filter: { games: "", apps: "" }, sort: { games: "size", apps: "size" }, onlyLikely: true,
  explore: { files: [], system: [] },
};

/** One drive as a tree: categories, then apps/areas, then their parts and
 *  folders. Each node gets a colour and its slice of the circle (x0..x1). */
function buildTree(inv, d) {
  const dk = d.root.slice(0, 2).toUpperCase();
  const on = (p) => String(p).slice(0, 2).toUpperCase() === dk;
  const fromNode = (n) => ({ name: n.name, size: n.totals.allocated, path: n.path, children: (n.children || []).map(fromNode) });
  const appNode = (a) => {
    const parts = a.parts.filter((p) => on(p.path));
    return {
      name: a.app.name, appId: a.app.id, size: sum(parts, (p) => p.totals.allocated),
      children: parts.map((p) => ({ name: p.location, path: p.path, appId: a.app.id, size: p.totals.allocated })),
    };
  };
  const cat = (id, children) => ({ name: CATS[id].label, cat: id, size: sum(children), children });
  const areas = (c) => d.areas.filter((a) => AREA_CAT[a.kind] === c).map((a) => ({ ...fromNode(a.node), name: a.label }));
  const root = {
    name: d.root, root: true, size: d.total,
    children: [
      cat("games", inv.apps.filter((a) => a.app.game).map(appNode)),
      cat("apps", inv.apps.filter((a) => !a.app.game).map(appNode)),
      cat("files", areas("files")),
      cat("system", areas("system")),
      cat("leftovers", inv.unclaimed.filter((u) => on(u.path)).map((u) => ({ name: leaf(u.path), path: u.path, size: u.totals.allocated }))),
      { name: "Not readable without admin", cat: "unreadable", size: d.unreadable },
      { name: "Free space", cat: "free", size: d.free },
    ],
  };
  layout(root, null, 0, 0, 1, null);
  return root;
}

function layout(n, parent, depth, x0, x1, catId) {
  Object.assign(n, { parent, depth, x0, x1 });
  n.cat = n.cat || catId;
  const c = CATS[n.cat];
  if (depth === 1 || !c?.h) n.color = c?.hex || c?.css || "var(--faint)";
  if (!n.children) return;
  n.children = n.children.filter((k) => k.size > 0).sort((a, b) => b.size - a.size).slice(0, 60);
  const total = n.root ? n.size : Math.max(n.size, sum(n.children));
  let x = x0;
  n.children.forEach((k, i) => {
    const w = total > 0 ? ((x1 - x0) * k.size) / total : 0;
    if (c?.h && depth >= 1) {
      // Same hue as the category, a little darker each ring, alternating.
      const l = c.l - depth * 7 + ((i % 4) - 1.5) * 4;
      k.color = `hsl(${c.h} ${c.s}% ${Math.max(28, l)}%)`;
    }
    layout(k, n, depth + 1, x, x + w, n.cat || k.cat);
    x += w;
  });
}

function catNode(tree, id) {
  return tree.children.find((c) => c.cat === id);
}
function allCat(id) {
  return sum(state.trees, (t) => catNode(t, id)?.size || 0);
}

// ----------------------------------------------------------------- data

async function load(rescan) {
  state.scanning = true;
  state.t0 = performance.now();
  state.progress = "Starting";
  $("#btn-rescan").classList.add("spinning");
  if (!state.inv) render();
  renderSide();
  const tick = setInterval(renderSide, 500);
  try {
    const inv = await invoke("inventory", { rescan });
    state.inv = inv;
    state.apps = new Map(inv.apps.map((a) => [a.app.id, a]));
    state.trees = inv.drives.map((d) => buildTree(inv, d));
    state.drive = Math.max(0, inv.drives.reduce((b, d, i, a) => (d.total - d.free > a[b].total - a[b].free ? i : b), 0));
    state.explore = { files: [], system: [] };
    burst.focus = null;
    if (rescan) {
      state.dev = null;
      state.sys = null;
      toast(`Rescanned in ${((performance.now() - state.t0) / 1000).toFixed(1)} s`);
    }
  } catch (e) {
    toast(`Scan failed: ${esc(e)}`, 8000);
  } finally {
    clearInterval(tick);
    state.scanning = false;
    $("#btn-rescan").classList.remove("spinning");
    render();
  }
}

async function ensure(page) {
  const want = page === "dev" ? "dev" : page === "system" ? "sys" : null;
  if (!want || state[want]) return;
  try {
    state[want] = want === "dev" ? await invoke("dev_items") : await invoke("system_items");
  } catch (e) {
    toast(esc(e));
    state[want] = want === "dev" ? { projects: [], global: [] } : [];
  }
  if (state.page === page) render();
}

// ---------------------------------------------------------------- images

const images = new Map();
function imageFor(path) {
  if (!images.has(path)) images.set(path, invoke("icon", { path }).catch(() => null));
  return images.get(path);
}
const seen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      seen.unobserve(e.target);
      const img = e.target;
      imageFor(img.dataset.src).then((url) => {
        if (!url) return img.dispatchEvent(new Event("error"));
        img.src = url;
        img.onload = () => img.classList.add("on");
      });
    }
  },
  { rootMargin: "300px" },
);
function hydrate(root) {
  root.querySelectorAll("img[data-src]").forEach((img) => {
    img.onerror = () => {
      const ph = img.closest("[data-letter]");
      if (ph && !ph.querySelector(".cover.on")) ph.innerHTML = `<span class="letter">${esc(ph.dataset.letter)}</span>`;
      img.remove();
    };
    seen.observe(img);
  });
}
function iconHtml(app, cls = "") {
  const letter = (app.name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  return app.icon
    ? `<span class="${cls}" data-letter="${esc(letter)}"><img data-src="${esc(app.icon)}" alt=""></span>`
    : `<span class="${cls}" data-letter="${esc(letter)}"><span class="letter">${esc(letter)}</span></span>`;
}

// --------------------------------------------------------------- sidebar

const PAGES = [
  ["overview", "Overview"],
  ["games", "Games"],
  ["apps", "Apps"],
  ["files", "Your files"],
  ["system", "Windows & system"],
  ["leftovers", "Leftovers"],
  ["dev", "Developer"],
];

function renderSide() {
  const used = state.inv ? sum(state.inv.drives, (d) => d.total - d.free) : 0;
  const size = (id) => {
    if (!state.inv) return "";
    if (id === "overview") return human(used);
    if (id === "dev") return state.dev ? human(sum([...state.dev.projects, ...state.dev.global], (x) => x.totals.allocated)) : "";
    return human(allCat(id));
  };
  $("#nav").innerHTML = PAGES.map(([id, label], i) => {
    const color = CATS[id]?.hex;
    const mark = color ? `<span class="dotc" style="background:${color}"></span>` : id === "dev" ? ICON.code : ICON.overview;
    const sep = i === 1 || i === 6 ? '<div class="nav-sep"></div>' : "";
    return `${sep}<button class="nav-item ${state.page === id && !state.detail ? "active" : ""}" data-page="${id}">
      ${mark}<span class="lbl">${esc(label)}</span><span class="sz">${size(id)}</span></button>`;
  }).join("");
  const s = $("#scan-state");
  if (state.scanning) {
    const secs = ((performance.now() - state.t0) / 1000).toFixed(0);
    s.innerHTML = `<span class="spinner"></span>${esc(state.progress)}… ${secs} s`;
    const lm = $("#load-msg");
    if (lm) { lm.textContent = `${state.progress}…`; $("#load-time").textContent = `${secs} s`; }
  } else if (state.inv) {
    const files = state.inv.totals.files + sum(state.inv.drives, (d) => sum(d.areas, (a) => a.node.totals.files));
    s.textContent = `${fmt(files)} files · ${state.inv.scan_seconds.toFixed(1)} s`;
  } else s.textContent = "";
}

// ----------------------------------------------------------------- pages

function go(page, opts = {}) {
  if (state.detail) state.detail = null;
  state.prev = state.page;
  state.page = page;
  render();
  ensure(page);
  if (!opts.keepScroll) $("#main").scrollTop = 0;
}

function openApp(id, flashPath) {
  state.prev = state.page;
  state.detail = id;
  state.flashPath = flashPath || null;
  render();
  $("#main").scrollTop = 0;
}

function render() {
  renderSide();
  const main = $("#main");
  if (!state.inv) {
    main.innerHTML = `<div class="loading"><div class="box"><div class="big"><i></i><i></i><i></i><i></i></div>
      <div class="msg" id="load-msg">${esc(state.progress)}…</div><div class="time" id="load-time"></div></div></div>`;
    return;
  }
  const html = state.detail ? appPage(state.detail) : PAGE_HTML[state.page]();
  seen.disconnect(); // the old page's images are gone
  main.innerHTML = `<div class="page">${html}</div>`;
  if (!state.detail && state.page === "overview") burst.mount($("#burst"));
  animateIn(main);
  if (state.flashPath) {
    const el = main.querySelector(`.part[data-path="${CSS.escape(state.flashPath)}"]`);
    if (el) { el.classList.add("flash"); setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 200); }
    state.flashPath = null;
  }
}

function head(title, sub, tools = "") {
  return `<div class="head"><div><h1>${esc(title)}</h1><div class="sub">${sub}</div></div><div class="tools">${tools}</div></div>`;
}

const PAGE_HTML = {
  overview() {
    const inv = state.inv;
    const d = inv.drives[state.drive];
    const t = state.trees[state.drive];
    const used = d.total - d.free;
    const drives = inv.drives.length > 1
      ? `<div class="seg">${inv.drives.map((x, i) => `<button class="${i === state.drive ? "on" : ""}" data-drive="${i}">${esc(x.root.slice(0, 2))}</button>`).join("")}</div>`
      : "";
    const recycle = sum(d.areas.filter((a) => a.kind === "recycle-bin"), (a) => a.node.totals.allocated);
    const rec = sum(inv.apps, (a) => reclaim(a.totals));
    const likely = inv.unclaimed.filter((u) => u.possible_leftover);
    const top = [...inv.apps].sort((a, b) => b.totals.allocated - a.totals.allocated).slice(0, 8);
    const max = top[0]?.totals.allocated || 1;
    return `${head("Overview", `${esc(d.root)} · ${human(used)} used of ${human(d.total)} · ${human(d.free)} free`, drives)}
      <div class="ov">
        <div class="panel burst-card"><div class="burst-top"><div class="crumbs" id="crumbs"></div></div><svg class="burst" id="burst" viewBox="0 0 520 520"></svg></div>
        <div class="panel legend"><div class="stack">${t.children.filter((c) => c.cat !== "free")
          .map((c) => `<span style="background:${c.color}" data-w="${pct(c.size, d.total)}"></span>`).join("")}</div>
          <div id="legend"></div></div>
      </div>
      <div class="cards" style="margin-top:22px">
        <div class="card link" data-go="apps" data-sort="reclaimable"><div class="label">Reclaimable in apps</div><div class="value" data-count="${rec}">0 B</div><div class="hint">cache, logs, crash dumps, temp</div></div>
        <div class="card link" data-go="leftovers"><div class="label">Likely leftovers</div><div class="value" data-count="${sum(likely, (u) => u.totals.allocated)}">0 B</div><div class="hint">${likely.length} folders from uninstalled apps</div></div>
        <div class="card link" data-go="files"><div class="label">Recycle Bin</div><div class="value" data-count="${recycle}">0 B</div><div class="hint">deleted, not yet emptied</div></div>
        <div class="card"><div class="label">Not readable</div><div class="value" data-count="${d.unreadable}">0 B</div><div class="hint">needs admin (system folders)</div></div>
      </div>
      <h2 class="sec">Biggest apps and games</h2>
      <div class="rows">${top.map((a, i) => appRow(a, max, i)).join("")}</div>`;
  },

  games() {
    const list = sortFilter(state.inv.apps.filter((a) => a.app.game), "games");
    const total = sum(list, (a) => a.totals.allocated);
    return `${head("Games", `${list.length} games · ${human(total)}`, tools("games", [["size", "Size"], ["name", "Name"]]))}
      <div class="grid">${list.map((a, i) => gameCard(a, i)).join("") || '<div class="empty">No games match.</div>'}</div>`;
  },

  apps() {
    const list = sortFilter(state.inv.apps.filter((a) => !a.app.game), "apps");
    const max = Math.max(1, ...list.map((a) => a.totals.allocated));
    return `${head("Apps", `${list.length} apps · ${human(sum(list, (a) => a.totals.allocated))} · ${human(sum(list, (a) => reclaim(a.totals)))} reclaimable`,
      tools("apps", [["size", "Size"], ["reclaimable", "Reclaimable"], ["name", "Name"]]))}
      <div class="rows-head"><span></span><span>App</span><span></span><span>On disk</span><span>Reclaimable</span></div>
      <div class="rows">${list.map((a, i) => appRow(a, max, i)).join("") || '<div class="empty">No apps match.</div>'}</div>`;
  },

  files: () => explorer("files", "Your files", "Documents, downloads, projects and every other folder of yours, plus the Recycle Bin and other accounts."),
  system: () => explorer("system", "Windows & system", "Windows itself, shared program data no app claims, and leftover app data.") + systemItems(),

  leftovers() {
    const all = state.inv.unclaimed;
    const list = all.filter((u) => !state.onlyLikely || u.possible_leftover);
    const max = Math.max(1, ...list.map((u) => u.totals.allocated));
    const seg = `<div class="seg"><button class="${state.onlyLikely ? "on" : ""}" data-likely="1">Likely leftovers</button><button class="${state.onlyLikely ? "" : "on"}" data-likely="0">All unclaimed</button></div>`;
    return `${head("Leftovers", `${list.length} folders · ${human(sum(list, (u) => u.totals.allocated))}`, seg)}
      <div class="callout">Folders in the usual app places that no installed app claims. <b>Likely leftovers</b> haven't changed in six months, or are game folders a launcher no longer has installed. Strata never deletes anything: check a folder before removing it.</div>
      <div class="rows">${list.map((u, i) => folderRow({
        name: leaf(u.path), path: u.path, size: u.totals.allocated,
        sub: `${u.hint || u.location} · changed ${ago(u.totals.newest)}`,
        badge: u.possible_leftover ? "leftover?" : "",
      }, max, i)).join("") || '<div class="empty">Nothing here.</div>'}</div>`;
  },

  dev() {
    if (!state.dev) return head("Developer", "Measuring build output and caches…") + '<div class="skeleton"></div>'.repeat(8);
    const all = [...state.dev.projects, ...state.dev.global];
    const max = Math.max(1, ...all.map((x) => x.totals.allocated));
    const section = (title, xs) => `<h2 class="sec">${title}<span class="n">${human(sum(xs, (x) => x.totals.allocated))}</span></h2>
      <div class="rows">${xs.map((x, i) => devRow(x, max, i)).join("") || '<div class="empty">Nothing found.</div>'}</div>`;
    return head("Developer", "Build output and dependencies in your projects, and the caches, SDKs and virtual disks behind them.") +
      section("In projects", state.dev.projects) + section("Caches, toolchains and dev disks", state.dev.global);
  },
};

function tools(page, sorts) {
  return `<input class="filter" data-filter="${page}" placeholder="Filter…" value="${esc(state.filter[page])}" spellcheck="false">
    <div class="seg">${sorts.map(([k, l]) => `<button class="${state.sort[page] === k ? "on" : ""}" data-sort-page="${page}" data-sortk="${k}">${l}</button>`).join("")}</div>`;
}

function sortFilter(list, page) {
  const q = state.filter[page].trim().toLowerCase();
  if (q) list = list.filter((a) => `${a.app.name} ${a.app.publisher || ""} ${SOURCE[a.app.source]}`.toLowerCase().includes(q));
  const by = {
    size: (a, b) => b.totals.allocated - a.totals.allocated,
    reclaimable: (a, b) => reclaim(b.totals) - reclaim(a.totals),
    name: (a, b) => a.app.name.localeCompare(b.app.name),
  }[state.sort[page]];
  return [...list].sort(by);
}

const delay = (i) => `animation-delay:${Math.min(i * 18, 360)}ms`;

function appRow(a, max, i) {
  const sub = [a.app.publisher, `${a.parts.length} ${a.parts.length === 1 ? "place" : "places"}`].filter(Boolean).join(" · ");
  const color = a.app.game ? CATS.games.hex : CATS.apps.hex;
  return `<div class="row" data-app="${esc(a.app.id)}" style="${delay(i)}">
    ${iconHtml(a.app, "ic")}
    <div class="nm"><b>${esc(a.app.name)}</b><small>${esc(sub)}</small></div>
    <div class="meter"><i style="background:${color}" data-w="${Math.max(1, pct(a.totals.allocated, max))}"></i></div>
    <div class="v">${human(a.totals.allocated)}</div><div class="r">${human(reclaim(a.totals))}</div></div>`;
}

function gameCard(a, i) {
  const art = a.app.cover
    ? `<img class="cover" data-src="${esc(a.app.cover)}" alt="">`
    : "";
  return `<div class="game" data-app="${esc(a.app.id)}" style="${delay(i)}">
    <div class="art" style="--hue:${CATS.games.hex}">
      <div class="tile">${iconHtml(a.app)}</div>${art}
      <span class="src">${esc(SOURCE[a.app.source] || "")}</span><span class="size">${human(a.totals.allocated)}</span>
    </div>
    <div class="gn">${esc(a.app.name)}</div><div class="gs">${esc(a.app.publisher || SOURCE[a.app.source] || "")}</div></div>`;
}

function folderRow(f, max, i, color = "var(--c-files)") {
  return `<div class="row" ${f.drill != null ? `data-drill="${f.drill}"` : ""} style="${delay(i)}">
    <span class="ic folder">${ICON.folder}</span>
    <div class="nm"><b>${esc(f.name)}${f.badge ? `<span class="badge">${esc(f.badge)}</span>` : ""}</b><small>${esc(f.sub || f.path || "")}</small></div>
    <div class="meter"><i style="background:${color}" data-w="${Math.max(1, pct(f.size, max))}"></i></div>
    <div class="v">${human(f.size)}</div>
    <div class="acts">${f.path ? `<button class="icon-btn" data-reveal="${esc(f.path)}" title="Show in Explorer">${ICON.open}</button>` : ""}</div></div>`;
}

function devRow(x, max, i) {
  const cmd = (x.note.match(/`([^`]+)`/) || [])[1];
  const name = x.project ? leaf(x.project) : leaf(x.path);
  return `<div class="row" style="${delay(i)};cursor:default">
    <span class="ic folder">${ICON.code}</span>
    <div class="nm"><b>${esc(name)}<span class="badge ${x.reclaim === "rebuildable" ? "ok" : "mute"}">${esc(DEV_LABELS[x.kind] || x.kind)}</span></b>
      <small>${esc(x.note.replace(/`/g, ""))} · touched ${ago(x.totals.newest)}</small></div>
    <div class="meter"><i style="background:var(--accent)" data-w="${Math.max(1, pct(x.totals.allocated, max))}"></i></div>
    <div class="v">${human(x.totals.allocated)}</div>
    <div class="acts">${cmd ? `<button class="icon-btn" data-copy="${esc(cmd)}" title="Copy: ${esc(cmd)}">${ICON.copy}</button>` : ""}
      <button class="icon-btn" data-reveal="${esc(x.path)}" title="Show in Explorer">${ICON.open}</button></div></div>`;
}

/** A drill-down list of one category's folder tree. */
function explorer(page, title, sub) {
  const root = catNode(state.trees[state.drive], page);
  const stack = state.explore[page];
  const cur = stack[stack.length - 1] || root;
  const kids = cur.children || [];
  const max = Math.max(1, ...kids.map((k) => k.size));
  const crumbs = [root, ...stack].map((n, i) => `<button data-crumb="${page}:${i}">${esc(n.name)}</button>`).join("<span>›</span>");
  const rows = kids.map((k, i) => folderRow({
    name: k.name, path: k.path, size: k.size, drill: k.children?.length ? i : null,
    sub: `${pct(k.size, cur.size).toFixed(1)}% · ${k.path ? k.path : ""}`,
  }, max, i, CATS[page].hex)).join("");
  const rest = cur.size - sum(kids);
  return `${head(title, `${human(root.size)} on ${esc(state.inv.drives[state.drive].root)} · ${sub}`)}
    <div class="crumbs" style="margin-bottom:10px">${crumbs}</div>
    <div class="rows">${rows || '<div class="empty">No bigger folders inside.</div>'}</div>
    ${rest > 1048576 && kids.length ? `<div class="empty" style="padding:10px 14px">+ ${human(rest)} in files here and folders under 8 MB</div>` : ""}`;
}

function systemItems() {
  if (!state.sys) return `<h2 class="sec">Space Windows keeps</h2>${'<div class="skeleton"></div>'.repeat(4)}`;
  const xs = state.sys.filter((s) => s.totals.allocated > 0 || s.partial);
  return `<h2 class="sec">Space Windows keeps<span class="n">and how to shrink it</span></h2>
    <div class="rows">${xs.map((s, i) => {
      const [label, cls] = SAFETY[s.safety];
      return `<div class="row" style="${delay(i)};cursor:default"><span class="ic folder">${ICON.folder}</span>
        <div class="nm"><b>${esc(s.name)}<span class="badge ${cls}">${esc(label)}</span></b><small>${esc(s.what)} — ${esc(s.how.replace(/`/g, ""))}</small></div>
        <div></div><div class="v">${s.partial && !s.totals.allocated ? "admin" : human(s.totals.allocated) + (s.partial ? "+" : "")}</div>
        <div class="acts"><button class="icon-btn" data-reveal="${esc(s.path)}" title="Show in Explorer">${ICON.open}</button></div></div>`;
    }).join("")}</div>`;
}

function appPage(id) {
  const a = state.apps.get(id);
  if (!a) return head("Not found", "This app is gone after the last scan.");
  const t = a.totals;
  const letter = (a.app.name.match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  const pic = a.app.cover && a.app.game
    ? `<div class="pic cover" data-letter="${letter}"><img data-src="${esc(a.app.cover)}" alt=""></div>`
    : `<div class="pic" data-letter="${letter}">${a.app.icon ? `<img data-src="${esc(a.app.icon)}" alt="">` : `<span class="letter">${letter}</span>`}</div>`;
  const chips = [SOURCE[a.app.source], a.app.game ? "Game" : "App", a.app.publisher, a.app.version && `v${a.app.version}`]
    .filter(Boolean).map((c) => `<span class="chip">${esc(c)}</span>`).join("");
  const kinds = KINDS.filter(([k]) => t.by_kind[k] > 0);
  return `<button class="back" data-back>${ICON.back}Back</button>
    <div class="hero">${a.app.cover ? `<div class="bg" id="hero-bg"></div>` : ""}
      <div class="inner">${pic}<div><h1>${esc(a.app.name)}</h1><div class="chips">${chips}</div></div>
      <div class="bigsz"><div class="n" data-count="${t.allocated}">0 B</div><div class="s">${a.parts.length} ${a.parts.length === 1 ? "place" : "places"} · ${fmt(t.files)} files</div></div></div></div>
    <div class="meta">
      <div class="card"><div class="label">Reclaimable</div><div class="value">${human(reclaim(t))}</div><div class="hint">cache, logs, crash dumps, temp</div></div>
      ${a.app.reported_bytes ? `<div class="card"><div class="label">Installer says</div><div class="value">${human(a.app.reported_bytes)}</div><div class="hint">install folder only</div></div>` : ""}
      <div class="card"><div class="label">Last changed</div><div class="value">${ago(t.newest)}</div></div>
      ${t.cloud_only ? `<div class="card"><div class="label">Cloud-only files</div><div class="value">${fmt(t.cloud_only)}</div></div>` : ""}
    </div>
    <h2 class="sec">What it is</h2>
    <div class="kbar">${kinds.map(([k]) => `<span style="background:var(--k-${k})" data-w="${pct(t.by_kind[k], t.allocated)}"></span>`).join("")}</div>
    <div class="klegend">${kinds.map(([k, l]) => `<span><i class="dot" style="background:var(--k-${k})"></i>${l}<b>${human(t.by_kind[k])}</b></span>`).join("")}</div>
    <h2 class="sec">Where it lives</h2>
    <div class="parts">${a.parts.map((p, i) => `<div class="part" data-path="${esc(p.path)}" style="${delay(i)}">
      <div class="size">${human(p.totals.allocated)}</div>
      <div><div class="where">${esc(p.location)}<span class="conf ${p.confidence}">${p.confidence}</span></div>
        <div class="path">${esc(p.path)}</div><div class="why">${esc(p.reason)}</div></div>
      <button class="icon-btn" data-reveal="${esc(p.path)}" title="Show in Explorer">${ICON.open}</button></div>`).join("")}</div>`;
}

// ---------------------------------------------------------------- burst

/** The zoomable sunburst: three rings around the focused slice. Zooming
 *  animates the angle window and the ring depth together. */
const burst = {
  svg: null, focus: null, cur: null, raf: 0, hover: null,
  R: [92, 168, 216, 252], // ring edges: center hole, ring 1, 2, 3

  mount(svg) {
    this.svg = svg;
    const t = state.trees[state.drive];
    this.focus = this.focus && this.root() === t ? this.focus : t;
    this.cur = { x0: this.focus.x0, x1: this.focus.x1, d: this.focus.depth };
    this.nodes = [];
    const walk = (n) => { this.nodes.push(n); n.el = null; (n.children || []).forEach(walk); };
    walk(t);
    svg.innerHTML = `<g id="arcs"></g><g class="center"><circle r="88" cx="260" cy="260" fill="transparent"/>
      <text class="c-name" x="260" y="226" text-anchor="middle"></text>
      <text class="c-size" x="260" y="266" text-anchor="middle"></text>
      <text class="c-pct" x="260" y="290" text-anchor="middle"></text>
      <text class="c-act" x="260" y="316" text-anchor="middle"></text></g>`;
    svg.onmouseleave = () => this.setHover(null);
    $(".center", svg).onclick = () => this.centerClick();
    this.draw();
    this.side();
  },

  root() {
    let n = this.focus;
    while (n?.parent) n = n.parent;
    return n;
  },

  radius(level) {
    const l = Math.max(0, Math.min(3, level));
    const i = Math.min(2, Math.floor(l));
    return this.R[i] + (this.R[i + 1] - this.R[i]) * (l - i);
  },

  arc(a0, a1, r0, r1) {
    a1 = Math.min(a1, a0 + Math.PI * 2 - 1e-4);
    const p = (a, r) => `${(260 + r * Math.sin(a)).toFixed(2)} ${(260 - r * Math.cos(a)).toFixed(2)}`;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p(a0, r1)}A${r1} ${r1} 0 ${large} 1 ${p(a1, r1)}L${p(a1, r0)}A${r0} ${r0} 0 ${large} 0 ${p(a0, r0)}Z`;
  },

  draw() {
    const { x0, x1, d } = this.cur;
    const g = $("#arcs", this.svg);
    const span = x1 - x0;
    for (const n of this.nodes) {
      const rel = n.depth - d;
      const a0 = Math.max(0, Math.min(1, (n.x0 - x0) / span)) * Math.PI * 2;
      const a1 = Math.max(0, Math.min(1, (n.x1 - x0) / span)) * Math.PI * 2;
      const r0 = this.radius(rel - 1) + 1, r1 = this.radius(rel);
      const show = rel > 0.01 && rel <= 3.01 && a1 - a0 > 0.004 && r1 - r0 > 0.5;
      if (!show) { if (n.el) n.el.style.display = "none"; continue; }
      if (!n.el) {
        n.el = document.createElementNS("http://www.w3.org/2000/svg", "path");
        n.el.style.fill = n.color;
        if (n.cat === "free") n.el.style.fill = "var(--c-free)";
        n.el.onmouseenter = (e) => this.setHover(n, e);
        n.el.onmousemove = (e) => moveTip(e);
        n.el.onclick = () => this.click(n);
        g.appendChild(n.el);
      }
      n.el.style.display = "";
      n.el.setAttribute("d", this.arc(a0, a1, r0, r1));
    }
    this.label(this.hover || this.focus);
  },

  label(n) {
    const t = this.root();
    const [name, size, p, act] = this.svg.querySelectorAll(".center text");
    name.textContent = n.root ? `${n.name} drive` : n.name.length > 26 ? n.name.slice(0, 25) + "…" : n.name;
    size.textContent = human(n.root ? t.size - (catNode(t, "free")?.size || 0) : n.size);
    p.textContent = n.root ? `used of ${human(t.size)}` : `${pct(n.size, t.size).toFixed(1)}% of the drive`;
    act.textContent = n === this.hover ? (n.children?.length ? "click to zoom in" : n.appId ? "click to open" : "")
      : n.appId && n.depth === 2 ? "open app ›" : n !== t ? "‹ zoom out" : "";
  },

  setHover(n, e) {
    this.hover = n;
    this.svg.classList.toggle("hovering", !!n);
    for (const x of this.nodes) if (x.el) x.el.classList.toggle("hl", x === n);
    this.label(n || this.focus);
    const tip = $("#tip");
    if (!n) return tip.classList.remove("show");
    tip.innerHTML = `<b>${esc(n.name)}</b><span>${human(n.size)} · ${pct(n.size, n.parent?.size || n.size).toFixed(1)}% of ${esc(n.parent?.name || "")}</span>`;
    tip.classList.add("show");
    if (e) moveTip(e);
  },

  click(n) {
    if (n.children?.length) return this.zoom(n);
    if (n.appId) return openApp(n.appId, n.path);
    if (n.cat === "leftovers" && n.depth === 2) return go("leftovers");
  },

  centerClick() {
    const f = this.focus;
    if (f.appId && f.depth === 2) return openApp(f.appId);
    if (f.parent) this.zoom(f.parent);
  },

  zoom(n) {
    this.focus = n;
    this.setHover(null);
    const from = { ...this.cur }, to = { x0: n.x0, x1: n.x1, d: n.depth };
    const t0 = performance.now(), ms = 520;
    cancelAnimationFrame(this.raf);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.cur = { x0: from.x0 + (to.x0 - from.x0) * e, x1: from.x1 + (to.x1 - from.x1) * e, d: from.d + (to.d - from.d) * e };
      this.draw();
      if (p < 1) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.side();
  },

  /** Breadcrumbs above, and the legend beside, follow the focus. */
  side() {
    const chain = [];
    for (let n = this.focus; n; n = n.parent) chain.unshift(n);
    $("#crumbs").innerHTML = chain.map((n, i) => `<button data-zoom="${i}">${esc(n.root ? n.name : n.name)}</button>`).join("<span>›</span>");
    $("#crumbs").querySelectorAll("[data-zoom]").forEach((b) => (b.onclick = () => this.zoom(chain[+b.dataset.zoom])));
    const f = this.focus;
    const kids = (f.children || []).slice(0, 12);
    const base = f.root ? f.size : f.size;
    $("#legend").innerHTML = kids.map((k, i) => `<div class="lg-row" data-lg="${i}" style="${delay(i)}">
      <span class="sw" style="background:${k.cat === "free" ? "var(--c-free)" : k.color}"></span>
      <span class="nm">${esc(k.name)}<small>${k.children?.length ? `${k.children.length} inside` : k.appId ? "open" : ""}</small></span>
      <span class="v">${human(k.size)}</span><span class="p">${pct(k.size, base).toFixed(1)}%</span></div>`).join("");
    $("#legend").querySelectorAll("[data-lg]").forEach((r) => {
      const k = kids[+r.dataset.lg];
      r.onclick = () => (k.cat && k.depth === 1 && !k.children?.length ? null : this.click(k));
      r.onmouseenter = () => { this.setHover(k); $("#tip").classList.remove("show"); };
      r.onmouseleave = () => this.setHover(null);
    });
  },
};

function moveTip(e) {
  const tip = $("#tip");
  tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14) + "px";
  tip.style.top = e.clientY + 16 + "px";
}

// --------------------------------------------------------------- search

const pal = { open: false, results: [], active: 0 };

function paletteEntries() {
  const out = PAGES.map(([id, label]) => ({ k: "Go to", t: label, run: () => go(id) }));
  out.push({ k: "Command", t: "Rescan", run: () => !state.scanning && load(true) });
  out.push({ k: "Command", t: "Toggle light / dark theme", run: toggleTheme });
  if (!state.inv) return out;
  for (const a of state.inv.apps)
    out.push({ k: a.app.game ? "Game" : "App", t: a.app.name, s: human(a.totals.allocated), run: () => openApp(a.app.id) });
  for (const u of state.inv.unclaimed)
    out.push({ k: "Leftover", t: u.path, s: human(u.totals.allocated), run: () => { state.onlyLikely = false; go("leftovers"); } });
  return out;
}

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
  const hl = (text, marks) => { const s = new Set(marks); return [...text].map((c, i) => (s.has(i) ? `<mark>${esc(c)}</mark>` : esc(c))).join(""); };
  $("#palette-results").innerHTML = pal.results.map((r, i) => `<div class="pr ${i === pal.active ? "active" : ""}" data-i="${i}">
    <span class="k">${esc(r.k)}</span><span class="t">${hl(r.t, r.marks)}</span><span class="s">${esc(r.s || "")}</span></div>`).join("")
    || '<div class="empty">No matches.</div>';
  $("#palette-results .pr.active")?.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  pal.open = true;
  $("#palette").hidden = false;
  $("#palette-input").value = "";
  updatePalette();
  $("#palette-input").focus();
}
function closePalette() { pal.open = false; $("#palette").hidden = true; }
function runPalette(i) { const r = pal.results[i]; closePalette(); r?.run(); }

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  store("strata.theme", next);
  if (state.inv && !state.detail && state.page === "overview") render();
}

// ---------------------------------------------------------------- events

function wire() {
  $("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-page]"); if (b) go(b.dataset.page); });
  $("#btn-search").onclick = openPalette;
  $("#btn-rescan").onclick = () => !state.scanning && load(true);
  $("#btn-theme").onclick = toggleTheme;

  const main = $("#main");
  main.addEventListener("click", async (e) => {
    const t = e.target;
    const rev = t.closest("[data-reveal]");
    if (rev) {
      e.stopPropagation();
      try { await invoke("reveal", { path: rev.dataset.reveal }); } catch (err) { toast(esc(err)); }
      return;
    }
    const cp = t.closest("[data-copy]");
    if (cp) {
      try { await navigator.clipboard.writeText(cp.dataset.copy); toast(`Copied <code>${esc(cp.dataset.copy)}</code>`); } catch { toast("Couldn't copy"); }
      return;
    }
    if (t.closest("[data-back]")) { state.detail = null; render(); return; }
    const app = t.closest("[data-app]");
    if (app) return openApp(app.dataset.app);
    const g = t.closest("[data-go]");
    if (g) { if (g.dataset.sort) state.sort.apps = g.dataset.sort; return go(g.dataset.go); }
    const drill = t.closest("[data-drill]");
    if (drill) {
      const page = state.page;
      const stack = state.explore[page];
      const cur = stack[stack.length - 1] || catNode(state.trees[state.drive], page);
      stack.push(cur.children[+drill.dataset.drill]);
      return render();
    }
    const crumb = t.closest("[data-crumb]");
    if (crumb) { const [page, i] = crumb.dataset.crumb.split(":"); state.explore[page].length = +i; return render(); }
    const sortb = t.closest("[data-sortk]");
    if (sortb) { state.sort[sortb.dataset.sortPage] = sortb.dataset.sortk; return render(); }
    const lk = t.closest("[data-likely]");
    if (lk) { state.onlyLikely = lk.dataset.likely === "1"; return render(); }
    const dr = t.closest("[data-drive]");
    if (dr) { state.drive = +dr.dataset.drive; burst.focus = null; state.explore = { files: [], system: [] }; return render(); }
  });
  main.addEventListener("input", (e) => {
    const f = e.target.closest("[data-filter]");
    if (!f) return;
    state.filter[f.dataset.filter] = f.value;
    const pos = f.selectionStart;
    render();
    const again = $(`[data-filter="${f.dataset.filter}"]`);
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  // The hero's blurred backdrop is the app's cover art.
  new MutationObserver(() => {
    const bg = $("#hero-bg");
    const a = state.detail && state.apps.get(state.detail);
    if (bg && a?.app.cover && !bg.dataset.done) {
      bg.dataset.done = "1";
      imageFor(a.app.cover).then((url) => url && (bg.style.backgroundImage = `url("${url}")`));
    }
  }).observe(main, { childList: true });

  $("#palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
  $("#palette-input").addEventListener("input", updatePalette);
  $("#palette-results").addEventListener("mousemove", (e) => {
    const r = e.target.closest(".pr");
    if (r && +r.dataset.i !== pal.active) { pal.active = +r.dataset.i; drawPalette(); }
  });
  $("#palette-results").addEventListener("click", (e) => { const r = e.target.closest(".pr"); if (r) runPalette(+r.dataset.i); });

  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (pal.open) {
      if (e.key === "Escape") closePalette();
      else if (e.key === "ArrowDown") { pal.active = Math.min(pal.results.length - 1, pal.active + 1); drawPalette(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { pal.active = Math.max(0, pal.active - 1); drawPalette(); e.preventDefault(); }
      else if (e.key === "Enter") runPalette(pal.active);
      return;
    }
    const k = e.key.toLowerCase();
    if (ctrl && (k === "k" || k === "p")) { e.preventDefault(); openPalette(); }
    else if (ctrl && k === "r") { e.preventDefault(); if (!state.scanning) load(true); }
    else if (ctrl && /^[1-7]$/.test(e.key)) { e.preventDefault(); go(PAGES[+e.key - 1][0]); }
    else if (e.key === "Escape" || (e.key === "Backspace" && !/input/i.test(document.activeElement?.tagName))) {
      if (state.detail) { state.detail = null; render(); }
      else if (state.page === "overview" && burst.focus?.parent) burst.zoom(burst.focus.parent);
      else if (state.explore[state.page]?.length) { state.explore[state.page].pop(); render(); }
    }
  });

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
      if (!w) return toast(`<b>${esc(leaf(path))}</b> isn't in an app's folder. Look for it under Your files or Windows.`, 5000);
      if (w.app) {
        const a = state.inv.apps.find((x) => x.app.name === w.app);
        if (a) openApp(a.app.id, w.part);
        toast(`<b>${esc(leaf(path))}</b> belongs to <b>${esc(w.app)}</b>`, 4500);
      } else {
        state.onlyLikely = false;
        go("leftovers");
        toast(`<b>${esc(leaf(path))}</b> isn't claimed by any installed app`, 4500);
      }
    } catch (err) { toast(esc(err)); }
  });
  listen("scan-progress", (ev) => { state.progress = ev.payload; renderSide(); });
}

document.documentElement.dataset.theme = store("strata.theme") || "dark";
wire();
render();
invoke("ui_ready").catch(() => {});
load(false);
