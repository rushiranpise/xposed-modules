#!/usr/bin/env node
"use strict";

/**
 * Build the static site (site/index.html) from data/repos.json.
 *
 * Usage:
 *   node scripts/build-site.js
 *
 * Produces a single self-contained HTML file (inline CSS + JS + embedded
 * JSON), so it works anywhere static hosting exists (GitHub Pages etc.).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "repos.json");
const SITE_DIR = path.join(ROOT, "site");
const OUT_FILE = path.join(SITE_DIR, "index.html");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function main() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`Missing ${DATA_FILE}. Run "node scripts/find-repos.js" first.`);
    process.exit(1);
  }

  let repos = [];
  try {
    repos = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(repos)) repos = [];
  } catch (err) {
    console.error(`Could not parse ${DATA_FILE}: ${err.message}`);
    process.exit(1);
  }

  const now = Date.now();
  const freshCount = repos.filter(
    (r) => r.added_at && now - new Date(r.added_at).getTime() < WEEK_MS
  ).length;
  const officialCount = repos.filter((r) => (r.source || "").startsWith("lsposed-repo")).length;

  const data = {
    generated_at: new Date().toISOString(),
    total: repos.length,
    fresh: freshCount,
    official: officialCount,
    repos,
  };

  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, render(data));
  console.log(`Built ${OUT_FILE} (${repos.length} repos, ${freshCount} new this week)`);
}

function render(data) {
  // Escape "<" so a description can never break out of the <script> tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Xposed Modules Directory</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='1' y='1' width='14' height='14' rx='4' fill='%23ff7a3d'/%3E%3Ctext x='8' y='12' font-size='10' font-family='sans-serif' font-weight='bold' text-anchor='middle' fill='%230b0f14'%3EX%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #0b0f14;
    --bg-soft: #10151c;
    --card: #151b24;
    --card-hover: #1a222e;
    --border: #232d3a;
    --text: #e6edf3;
    --muted: #8b98a5;
    --accent: #ff7a3d;
    --accent-2: #ffb84d;
    --new: #3fb950;
    --archived: #6e7681;
    --radius: 14px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { color-scheme: dark; }
  body {
    background:
      radial-gradient(1000px 500px at 85% -10%, rgba(255, 122, 61, .14), transparent 60%),
      radial-gradient(900px 500px at -10% 0%, rgba(255, 184, 77, .08), transparent 55%),
      var(--bg);
    color: var(--text);
    font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
    min-height: 100vh;
  }
  header {
    padding: 56px 24px 40px;
    text-align: center;
  }
  .logo {
    display: inline-flex;
    align-items: center;
    gap: 14px;
    font-size: 40px;
    font-weight: 800;
    letter-spacing: -.5px;
  }
  .logo-badge {
    width: 52px; height: 52px;
    border-radius: 14px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    display: grid; place-items: center;
    font-size: 26px; font-weight: 900; color: #0b0f14;
    box-shadow: 0 8px 30px rgba(255, 122, 61, .35);
  }
  .logo .grad { background: linear-gradient(90deg, var(--accent), var(--accent-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tagline { color: var(--muted); margin-top: 10px; font-size: 16px; }
  .stats { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
  .stat {
    background: var(--card); border: 1px solid var(--border); border-radius: 999px;
    padding: 8px 18px; font-size: 14px; color: var(--muted);
  }
  .stat b { color: var(--text); font-weight: 700; }

  .toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    max-width: 1200px; margin: 0 auto 28px; padding: 14px 24px;
    background: rgba(11, 15, 20, .85); backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
  }
  .search-wrap { position: relative; flex: 1 1 280px; }
  .search-wrap svg { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); opacity: .5; }
  #search {
    width: 100%;
    background: var(--card); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 14px 10px 38px; font-size: 15px; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  #search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 122, 61, .18); }
  select {
    background: var(--card); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; font-size: 14px; outline: none; cursor: pointer;
  }
  .seg {
    display: inline-flex; background: var(--card);
    border: 1px solid var(--border); border-radius: 10px; padding: 3px; gap: 2px;
  }
  .seg button {
    border: 0; background: transparent; color: var(--muted);
    font-size: 13px; font-weight: 600; padding: 7px 14px;
    border-radius: 7px; cursor: pointer; font-family: inherit;
    transition: background .15s, color .15s, box-shadow .15s;
  }
  .seg button:hover { color: var(--text); }
  .seg button.active {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #0b0f14; box-shadow: 0 2px 10px rgba(255, 122, 61, .35);
  }
  .check {
    display: inline-flex; align-items: center; gap: 8px;
    color: var(--muted); font-size: 14px; cursor: pointer; user-select: none;
    padding: 10px 6px;
  }
  .check input { accent-color: var(--accent); width: 16px; height: 16px; cursor: pointer; }
  #count { margin-left: auto; color: var(--muted); font-size: 13px; }

  main { max-width: 1200px; margin: 0 auto; padding: 0 24px 60px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
  }
  .card {
    background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 18px; display: flex; flex-direction: column; gap: 12px;
    transition: transform .15s ease, border-color .15s ease, background .15s ease;
  }
  .card:hover { transform: translateY(-3px); border-color: #33414f; background: var(--card-hover); }
  .card-top { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .avatar {
    width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
    background: var(--bg-soft); border: 1px solid var(--border);
  }
  .card-name { min-width: 0; }
  .card-name a {
    color: var(--text); text-decoration: none; font-weight: 700; font-size: 15px;
    display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .card-name a:hover { color: var(--accent); }
  .card-owner { color: var(--muted); font-size: 12.5px; }
  .desc {
    color: #b6c2cf; font-size: 13.5px; line-height: 1.5;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; min-height: 61px;
  }
  .desc:empty::before { content: "No description provided."; color: var(--archived); }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; }
  .tag {
    font-size: 11.5px; padding: 3px 9px; border-radius: 999px;
    background: rgba(255, 122, 61, .12); color: var(--accent-2);
    border: 1px solid rgba(255, 122, 61, .25);
  }
  .tag.more { background: var(--bg-soft); color: var(--muted); border-color: var(--border); }
  .card-foot {
    display: flex; align-items: center; gap: 14px;
    font-size: 12.5px; color: var(--muted);
    border-top: 1px solid var(--border); padding-top: 12px;
    margin-top: auto;
  }
  .stars { color: var(--accent-2); font-weight: 700; display: inline-flex; align-items: center; gap: 4px; }
  .lang { display: inline-flex; align-items: center; gap: 5px; }
  .lang-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dot, #8b98a5); }
  .updated { margin-left: auto; }
  .badges { display: flex; gap: 6px; }
  .badge { font-size: 10.5px; font-weight: 700; letter-spacing: .4px; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; }
  .badge.new { background: rgba(63, 185, 80, .15); color: var(--new); border: 1px solid rgba(63, 185, 80, .35); }
  .badge.archived { background: rgba(110, 118, 129, .15); color: var(--archived); border: 1px solid rgba(110, 118, 129, .35); }
  .badge.official { background: rgba(255, 184, 77, .12); color: var(--accent-2); border: 1px solid rgba(255, 184, 77, .3); }
  .badges .badge + .badge { margin-left: 0; }
  .official-chip { color: var(--accent-2); font-weight: 700; font-size: 12px; letter-spacing: .3px; }
  .app-meta {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 12.5px; color: var(--muted);
  }
  .app-version {
    font-weight: 700; color: var(--accent-2);
    min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .app-date { flex-shrink: 0; white-space: nowrap; }
  .release-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 12px; font-weight: 700; color: var(--accent-2);
    background: rgba(255, 122, 61, .1); border: 1px solid rgba(255, 122, 61, .35);
    padding: 2px 9px; border-radius: 6px; text-decoration: none;
    transition: background .15s, border-color .15s;
  }
  .release-chip:hover { background: rgba(255, 122, 61, .2); border-color: var(--accent); }
  .release-chip.prerelease { border-style: dashed; opacity: .85; }
  .empty {
    text-align: center; color: var(--muted); padding: 60px 0;
    font-size: 15px;
  }
  .hidden { display: none; }
  footer {
    text-align: center; color: var(--muted); font-size: 13px;
    padding: 30px 24px 48px; border-top: 1px solid var(--border);
  }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .logo { font-size: 30px; }
  }
</style>
</head>
<body>
<header>
  <div class="logo"><span class="logo-badge">X</span><span class="grad">Xposed Modules Directory</span></div>
  <p class="tagline">Mega collection of Xposed &amp; LSPosed modules of all time — updated daily.</p>
  <div class="stats">
    <span class="stat"><b id="stat-total">0</b> modules</span>
    <span class="stat"><b id="stat-official">0</b> from the official LSPosed repo</span>
    <span class="stat"><b id="stat-new">0</b> new this week</span>
    <span class="stat">Updated <b id="stat-updated">—</b></span>
  </div>
</header>

<div class="toolbar">
  <div class="search-wrap">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="search" type="search" placeholder="Search modules, topics, languages…" autocomplete="off">
  </div>
  <select id="sort" aria-label="Sort order">
    <option value="updated">Sort: Updated</option>
    <option value="stars">Sort: Most stars</option>
    <option value="name">Sort: Name A–Z</option>
    <option value="released">Sort: Latest release</option>
    <option value="added">Sort: Newest added</option>
  </select>
  <div class="seg" id="type-filter" role="group" aria-label="Module type">
    <button data-type="all" class="active" aria-pressed="true" title="Show all modules">All</button>
    <button data-type="official" title="Only modules from the official LSPosed repo">Official</button>
    <button data-type="unofficial" title="Only modules found by code-marker verification">Unofficial</button>
  </div>
  <label class="check"><input type="checkbox" id="hide-archived" checked> Hide archived</label>
  <span id="count"></span>
</div>

<main>
  <div id="grid" class="grid"></div>
  <p id="empty" class="empty hidden">No repos match your search.</p>
</main>

<footer>
  Generated by a <a href="https://github.com/features/actions">GitHub Actions</a> workflow on <span id="gen-date"></span> ·
  data from the official <a href="https://github.com/Xposed-Modules-Repo">LSPosed module repository</a> (modules.lsposed.org)
  plus GitHub search — candidates are verified by module markers (<code>xposed_init</code>, <code>module.prop</code>, <code>module.json</code>),
  each card shows the latest release and last update, and new modules are added automatically, never duplicated.
</footer>

<script id="repo-data" type="application/json">${json}</script>
<script>
(function () {
  const DATA = JSON.parse(document.getElementById("repo-data").textContent);

  const LANG_COLORS = {
    Java: "#b07219", Kotlin: "#a97bff", C: "#555555", "C++": "#f34b7d",
    JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5",
    Dart: "#00B4AB", Shell: "#89e051", "C#": "#178600", Go: "#00ADD8",
    Rust: "#dea584", Swift: "#F05138", Vue: "#41b883", HTML: "#e34c26",
    CSS: "#563d7c", Zig: "#ec915c", Ruby: "#701516"
  };
  const fmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const fmtFull = new Intl.NumberFormat("en");
  const isOfficial = (r) => (r.source || "").startsWith("lsposed-repo");

  const el = {
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    count: document.getElementById("count"),
    search: document.getElementById("search"),
    sort: document.getElementById("sort"),
    hideArchived: document.getElementById("hide-archived"),
  };

  document.getElementById("stat-total").textContent = fmtFull.format(DATA.total);
  document.getElementById("stat-official").textContent = fmtFull.format(DATA.official);
  document.getElementById("stat-new").textContent = fmtFull.format(DATA.fresh);
  const gen = new Date(DATA.generated_at);
  document.getElementById("stat-updated").textContent = gen.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  document.getElementById("gen-date").textContent = gen.toLocaleString();

  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 2592000) return Math.floor(s / 86400) + "d ago";
    if (s < 31536000) return Math.floor(s / 2592000) + "mo ago";
    return Math.floor(s / 31536000) + "y ago";
  }

  function card(repo) {
    const c = document.createElement("article");
    c.className = "card";
    const isOfficialOnly = repo.source === "lsposed-repo";

    const top = document.createElement("div");
    top.className = "card-top";

    const img = document.createElement("img");
    img.className = "avatar";
    img.alt = "";
    img.loading = "lazy";
    img.src = repo.owner && repo.owner.avatar_url ? repo.owner.avatar_url : "";
    if (!img.src) img.style.display = "none";
    img.addEventListener("error", () => { img.style.display = "none"; });

    const names = document.createElement("div");
    names.className = "card-name";
    const a = document.createElement("a");
    a.href = repo.html_url || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = repo.full_name;
    const owner = document.createElement("div");
    owner.className = "card-owner";
    if (isOfficialOnly) {
      owner.textContent = "from Official LSPosed module repo";
    } else {
      const parts = [];
      if (repo.owner && repo.owner.login) parts.push("@" + repo.owner.login);
      if (repo.package) parts.push(repo.package);
      owner.textContent = parts.join(" \u00b7 ");
    }
    names.append(a, owner);
    top.append(img, names);
    c.append(top);

    const desc = document.createElement("p");
    desc.className = "desc";
    desc.textContent = repo.description || repo.summary || "";
    c.append(desc);

    const release = repo.release || {};
    const version =
      release.tag ||
      (repo.metadata && repo.metadata.version ? repo.metadata.version : "");
    if (version) {
      const meta = document.createElement("div");
      meta.className = "app-meta";
      const ver = document.createElement("span");
      ver.className = "app-version";
      ver.textContent = version.startsWith("v") ? version : "v" + version;
      ver.title = "Version " + ver.textContent;
      meta.append(ver);
      if (release.published_at) {
        const date = document.createElement("span");
        date.className = "app-date";
        date.textContent = "released " + timeAgo(release.published_at);
        date.title = "Released " + new Date(release.published_at).toLocaleDateString();
        meta.append(date);
      }
      c.append(meta);
    }

    const tags = isOfficialOnly ? repo.scope || [] : repo.topics || [];
    if (tags.length) {
      const tagsEl = document.createElement("div");
      tagsEl.className = "tags";
      const shown = tags.slice(0, 4);
      shown.forEach((t) => {
        const s = document.createElement("span");
        s.className = "tag";
        s.textContent = t;
        tagsEl.append(s);
      });
      if (tags.length > 4) {
        const more = document.createElement("span");
        more.className = "tag more";
        more.textContent = "+" + (tags.length - 4);
        tagsEl.append(more);
      }
      c.append(tagsEl);
    }

    const foot = document.createElement("div");
    foot.className = "card-foot";

    if (typeof repo.stargazers_count === "number") {
      const stars = document.createElement("span");
      stars.className = "stars";
      stars.textContent = "★ " + fmt.format(repo.stargazers_count);
      foot.append(stars);
    } else if (isOfficialOnly) {
      const chip = document.createElement("span");
      chip.className = "official-chip";
      chip.textContent = "Official";
      foot.append(chip);
    }

    if (repo.language) {
      const lang = document.createElement("span");
      lang.className = "lang";
      const dot = document.createElement("span");
      dot.className = "lang-dot";
      dot.style.setProperty("--dot", LANG_COLORS[repo.language] || "#8b98a5");
      lang.append(dot, document.createTextNode(repo.language));
      foot.append(lang);
    }

    const badges = document.createElement("span");
    badges.className = "badges";
    if (!isOfficialOnly && isOfficial(repo)) {
      const b = document.createElement("span");
      b.className = "badge official";
      b.textContent = "Official";
      badges.append(b);
    }
    if (!isOfficialOnly && repo.added_at && Date.now() - new Date(repo.added_at).getTime() < 7 * 86400000) {
      const b = document.createElement("span");
      b.className = "badge new";
      b.textContent = "New";
      badges.append(b);
    }
    if (repo.archived) {
      const b = document.createElement("span");
      b.className = "badge archived";
      b.textContent = "Archived";
      badges.append(b);
    }
    if (badges.childElementCount) foot.append(badges);

    if (release.tag) {
      const rel = document.createElement("a");
      rel.className = "release-chip" + (release.prerelease ? " prerelease" : "");
      rel.href = release.apk_url || release.html_url || "#";
      rel.target = "_blank";
      rel.rel = "noopener";
      rel.textContent = "\u2b07 Download latest";
      rel.title =
        "Release " + (release.name || release.tag) +
        (release.published_at
          ? " \u00b7 " + new Date(release.published_at).toLocaleDateString()
          : "") +
        (release.apk_url ? " \u00b7 direct APK download" : "");
      foot.append(rel);
    }

    const updated = document.createElement("span");
    updated.className = "updated";
    const commitAt = repo.pushed_at || repo.updated_at;
    if (commitAt) updated.textContent = "updated " + timeAgo(commitAt);
    foot.append(updated);

    c.append(foot);
    return c;
  }

  function visible(repos) {
    const q = el.search.value.trim().toLowerCase();
    let list = repos.filter((r) => {
      if (el.hideArchived.checked && r.archived) return false;
      if (typeFilter === "official" && !isOfficial(r)) return false;
      if (typeFilter === "unofficial" && isOfficial(r)) return false;
      if (!q) return true;
      return (
        r.full_name.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q) ||
        (r.summary || "").toLowerCase().includes(q) ||
        (r.package || "").toLowerCase().includes(q) ||
        (r.language || "").toLowerCase().includes(q) ||
        (r.release && r.release.tag ? r.release.tag.toLowerCase().includes(q) : false) ||
        (r.scope || r.topics || []).some((t) => t.toLowerCase().includes(q)) ||
        (r.owner && r.owner.login.toLowerCase().includes(q))
      );
    });
    const sortBy = el.sort.value;
    list = list.slice().sort((a, b) => {
      if (sortBy === "name") return a.full_name.localeCompare(b.full_name);
      if (sortBy === "updated") {
        const ca = a.pushed_at || a.updated_at || "";
        const cb = b.pushed_at || b.updated_at || "";
        return cb.localeCompare(ca);
      }
      if (sortBy === "released") {
        const ra = a.release && a.release.published_at ? a.release.published_at : "";
        const rb = b.release && b.release.published_at ? b.release.published_at : "";
        return rb.localeCompare(ra);
      }
      if (sortBy === "added") return (b.added_at || "").localeCompare(a.added_at || "");
      return (b.stargazers_count || 0) - (a.stargazers_count || 0);
    });
    return list;
  }

  function render() {
    const list = visible(DATA.repos);
    el.grid.replaceChildren(...list.map(card));
    el.empty.classList.toggle("hidden", list.length !== 0);
    el.count.textContent = list.length + " of " + DATA.repos.length + " modules";
  }

  let typeFilter = "all";
  const typeButtons = Array.from(document.querySelectorAll("#type-filter button"));
  typeButtons.forEach((b) =>
    b.addEventListener("click", () => {
      typeFilter = b.dataset.type;
      typeButtons.forEach((x) => {
        const on = x === b;
        x.classList.toggle("active", on);
        x.setAttribute("aria-pressed", String(on));
      });
      render();
    })
  );

  el.search.addEventListener("input", render);
  el.sort.addEventListener("change", render);
  el.hideArchived.addEventListener("change", render);
  render();
})();
</script>
</body>
</html>
`;
}

main();
