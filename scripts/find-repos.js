#!/usr/bin/env node
"use strict";

/**
 * Build a curated list of Xposed/LSPosed module repositories.
 *
 * Usage:
 *   node scripts/find-repos.js [--max-pages N] [--delay MS] [--queries "q1|q2"] [--no-org] [--ignore-ttl-days N] [--release-ttl-days N] [--api-scan N]
 *
 * The list is built from two sources:
 *
 * 1. The OFFICIAL LSPosed module repository — the Xposed-Modules-Repo GitHub
 *    org, the same data that powers modules.lsposed.org. Every repo there is
 *    a module entry: the repo name is the module's package id, SUMMARY holds
 *    the module name, SOURCE_URL points to the real source repository and
 *    SCOPE lists the packages the module hooks.
 *
 * 2. GitHub search, to also discover modules that are NOT in the official
 *    repository. Every candidate is verified as a real module by looking for
 *    the marker files Xposed/LSPosed actually require in the source code:
 *      - xposed_init   (classic Xposed entry point)
 *      - module.prop   (LSPosed module properties)
 *      - module.json   (LSPosed module repo format)
 *    Marker paths are probed via raw.githubusercontent.com (free, does not
 *    count against API rate limits). When GITHUB_TOKEN is set, candidates
 *    that miss every probe get a full git-tree scan, which catches modules
 *    with unusual directory layouts.
 *
 * Candidates that fail verification go into data/ignored.json so they are
 * not re-checked on every run. Verified repos are stored in data/repos.json
 * and are never duplicated — each run only appends NEW modules.
 *
 * Set GITHUB_TOKEN to authenticate (higher rate limits + full tree scan).
 * GitHub Actions passes its token automatically via the workflow.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "repos.json");
const IGNORED_FILE = path.join(DATA_DIR, "ignored.json");

const ORG = "Xposed-Modules-Repo"; // official LSPosed module repository

// Repos inside the org that are NOT modules (org profile, submission page, etc.)
const ORG_META_REPOS = new Set([".github", "modules", "submission", "test--123123"]);

// GitHub search syntax. Edit these to widen/narrow what gets collected.
const DEFAULT_QUERIES = [
  "topic:xposed-module",
  "topic:lsposed-module",
  "topic:xposed",
  '"xposed module" in:name,description',
  '"xposed-module" in:name,description',
];

const DEFAULT_MAX_PAGES = 5; // pages per query; 100 repos per page, API caps at 1000/query
const DEFAULT_DELAY_MS = 1500; // politeness delay between API requests
const DEFAULT_IGNORE_TTL_DAYS = 30; // re-check rejected candidates after this long
const DEFAULT_RELEASE_TTL_DAYS = 7; // re-fetch latest release info after this long
const CONCURRENCY = 24; // parallel fetches for verification / metadata

// Marker files that identify a real Xposed/LSPosed module, probed at the
// most common source-layout paths via raw.githubusercontent.com (no API quota).
const PROBE_PATHS = [
  "module.json",
  "app/src/main/assets/module.prop",
  "app/src/main/assets/xposed_init",
  "assets/module.prop",
  "assets/xposed_init",
  "xposed/src/main/assets/xposed_init",
  "xposed/src/main/assets/module.prop",
  "module/src/main/assets/module.prop",
  "module/src/main/assets/xposed_init",
];

// Any file with one of these basenames anywhere in a repo's git tree = module.
const MARKER_BASENAMES = ["xposed_init", "module.prop", "module.json"];

function parseArgs(argv) {
  const args = {
    queries: DEFAULT_QUERIES,
    maxPages: DEFAULT_MAX_PAGES,
    delay: DEFAULT_DELAY_MS,
    noOrg: false,
    ignoreTtlDays: DEFAULT_IGNORE_TTL_DAYS,
    releaseTtlDays: DEFAULT_RELEASE_TTL_DAYS,
    apiScan: 0,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--max-pages":
        args.maxPages = parseInt(argv[++i], 10) || DEFAULT_MAX_PAGES;
        break;
      case "--delay":
        args.delay = parseInt(argv[++i], 10) || DEFAULT_DELAY_MS;
        break;
      case "--queries":
        args.queries = argv[++i].split("|").map((q) => q.trim()).filter(Boolean);
        break;
      case "--no-org":
        args.noOrg = true;
        break;
      case "--ignore-ttl-days":
        args.ignoreTtlDays = parseInt(argv[++i], 10) || DEFAULT_IGNORE_TTL_DAYS;
        break;
      case "--release-ttl-days":
        args.releaseTtlDays = parseInt(argv[++i], 10) || DEFAULT_RELEASE_TTL_DAYS;
        break;
      case "--api-scan": {
        // Force a git-tree scan for module.prop/module.json even without a token
        // (bypasses the metadata TTL). Optional count caps the number of scans.
        const n = parseInt(argv[i + 1], 10);
        if (Number.isFinite(n) && n >= 0) {
          args.apiScan = n;
          i++;
        } else {
          args.apiScan = 50;
        }
        break;
      }
      default:
        console.warn(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Set once a known rate-limit stop is underway, to suppress warning spam
// from in-flight parallel requests.
let quietWarnings = false;

function requestHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "xposed-modules-directory",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

function loadJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

// Keep only the fields the site needs, to keep repos.json small.
function pickRepo(item) {
  return {
    full_name: item.full_name,
    html_url: item.html_url,
    description: item.description || "",
    homepage: item.homepage || "",
    stargazers_count: item.stargazers_count || 0,
    forks_count: item.forks_count || 0,
    language: item.language || "",
    topics: Array.isArray(item.topics) ? item.topics : [],
    archived: !!item.archived,
    owner: item.owner
      ? { login: item.owner.login, avatar_url: item.owner.avatar_url }
      : null,
    created_at: item.created_at || "",
    updated_at: item.updated_at || "",
    pushed_at: item.pushed_at || "",
  };
}

async function searchRepositories(query, maxPages, delay) {
  const found = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", withNoForks(query));
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");

    const res = await githubGet(url);
    if (!res) break;
    if (!res.ok) {
      if (res.rateLimited) return { found, stopped: true };
      break;
    }
    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) break;
    found.push(...items);

    const total = body.total_count ?? 0;
    console.log(`  [${query}] page ${page}: ${items.length} repos (${total} match in total)`);

    if (found.length >= total || items.length < 100) break;
    if (delay > 0) await sleep(delay);
  }
  return { found, stopped: false };
}

// Wraps fetch() with auth headers, a timeout and rate-limit awareness.
async function githubGet(url) {
  try {
    const res = await fetch(url, { headers: requestHeaders(), signal: AbortSignal.timeout(20000) });
    if (!res.ok && (res.status === 403 || res.status === 429)) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (!quietWarnings) {
        console.warn(`  Rate limited (HTTP ${res.status}), remaining: ${remaining ?? "?"}`);
      }
      return { ok: false, rateLimited: remaining === "0" };
    }
    return res;
  } catch (err) {
    console.warn(`  Network error: ${err.message}`);
    return null;
  }
}

// Only exclude forks when the query doesn't already say something about forks.
function withNoForks(query) {
  return /\bfork:/i.test(query) ? query : `${query} fork:false`;
}

// Crawl the official LSPosed module repository org.
async function crawlOrgRepos(delay) {
  const all = [];
  for (let page = 1; ; page++) {
    const url = new URL(`https://api.github.com/orgs/${ORG}/repos`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await githubGet(url);
    if (!res) break;
    if (!res.ok) {
      console.warn(`  Stopping org crawl (HTTP ${res.status}).`);
      break;
    }
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    console.log(`  [${ORG}] page ${page}: ${items.length} repos`);
    if (items.length < 100) break;
    if (delay > 0) await sleep(delay);
  }
  return all.filter((r) => !r.fork && !ORG_META_REPOS.has(r.name));
}

// Fetch a file straight from the git CDN — free, no API quota.
async function rawFetch(fullName, filePath) {
  const [owner, repo] = fullName.split("/");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${encodedPath}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.status === 200) return { ok: true, body: await res.text() };
    return { ok: false, body: null };
  } catch {
    return { ok: false, body: null };
  }
}

// Check the common marker-file locations. Stops at the first hit.
async function probeRepo(fullName) {
  for (const probePath of PROBE_PATHS) {
    const r = await rawFetch(fullName, probePath);
    if (r.ok) return { verified: true, marker: probePath, body: r.body };
  }
  return { verified: false, marker: null, body: null };
}

// Scan the whole git tree for marker files (catches unusual layouts).
// Only used when a token is available; 1 API request per repo.
async function treeCheck(repo) {
  const branch = repo.default_branch || "HEAD";
  const url = `https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const res = await githubGet(url);
  if (!res || !res.ok) return { verified: false, marker: null };
  try {
    const body = await res.json();
    const hit = (body.tree || [])
      .map((f) => f.path)
      .find((p) => MARKER_BASENAMES.includes(p.split("/").pop()));
    return hit ? { verified: true, marker: hit } : { verified: false, marker: null };
  } catch {
    return { verified: false, marker: null };
  }
}

const API_NUM_KEYS = ["minApi", "maxApi", "minSdk", "maxSdk", "versionCode"];
const API_STR_KEYS = ["name", "version", "author", "description", "type"];
// libxposed META-INF/xposed/module.prop uses different keys for the framework
// API requirement: minApiVersion (minimum) and targetApiVersion (target).
const LIBXPOSED_KEYS = { minApiVersion: "minApi", targetApiVersion: "targetApi" };

function setNumericMeta(meta, key, raw) {
  const n = Number(String(raw).trim());
  if (Number.isFinite(n)) meta[key] = n;
}

// Extract name/version/author/description + framework API info (minApi/maxApi)
// from the marker file we found.
function parseMarkerBody(body, marker) {
  if (!body) return null;
  const base = marker.split("/").pop();
  const meta = {};
  if (base === "module.json") {
    try {
      const j = JSON.parse(body);
      if (j && typeof j === "object") {
        for (const key of API_STR_KEYS) {
          if (j[key]) meta[key] = String(j[key]);
        }
        for (const key of API_NUM_KEYS) {
          if (j[key] !== undefined) setNumericMeta(meta, key, j[key]);
        }
        // LSPosed module repo format nests the API requirement under "xposed".
        if (j.xposed && typeof j.xposed === "object") {
          for (const key of ["minApi", "maxApi", "minVersion"]) {
            if (j.xposed[key] !== undefined) setNumericMeta(meta, key, j.xposed[key]);
          }
        }
      }
    } catch {
      /* not JSON */
    }
  } else if (base === "module.prop") {
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(/^([\w.]+)\s*=\s*(.+)$/);
      if (!m) continue;
      const key = LIBXPOSED_KEYS[m[1]] || m[1];
      if (API_NUM_KEYS.includes(key) || key === "targetApi") {
        setNumericMeta(meta, key, m[2]);
      } else if (API_STR_KEYS.includes(key)) {
        meta[key] = m[2].trim();
      }
    }
  }
  return Object.keys(meta).length ? meta : null;
}

// module.prop / module.json paths used by the API-metadata refresh pass.
// Covers the classic template (app/src/main/assets) and the modern libxposed
// layout (src/main/resources/META-INF/xposed) for common module source dirs.
const META_PROBE_PATHS = [
  "module.json",
  "app/src/main/assets/module.prop",
  "assets/module.prop",
  "xposed/src/main/assets/module.prop",
  "module/src/main/assets/module.prop",
  "app/src/main/resources/META-INF/xposed/module.prop",
  "module/src/main/resources/META-INF/xposed/module.prop",
  "xposed/src/main/resources/META-INF/xposed/module.prop",
  "core/src/main/resources/META-INF/xposed/module.prop",
];

// Probe a repo specifically for its API metadata (prefers module.prop/module.json).
async function probeModuleMeta(fullName) {
  for (const p of META_PROBE_PATHS) {
    const r = await rawFetch(fullName, p);
    if (r.ok) return parseMarkerBody(r.body, p);
  }
  return null;
}

// Find a module.prop/module.json anywhere in the repo tree (1 API call).
// Catches unusual layouts like loader/sbl/src/main/resources/META-INF/xposed.
// Returns a status so the caller can tell a genuine "no module.prop" from a
// failed scan (rate limit / truncated tree) that should be retried later.
async function findModulePropInTree(fullName) {
  const url = new URL(`https://api.github.com/repos/${fullName}/git/trees/HEAD?recursive=1`);
  const res = await githubGet(url);
  if (!res) return { status: "error" };
  if (!res.ok) return res.rateLimited ? { status: "ratelimited" } : { status: "error" };
  try {
    const body = await res.json();
    if (body.truncated) return { status: "truncated" };
    const hit = (body.tree || []).find(
      (f) => /module\.(prop|json)$/.test(f.path) && !/node_modules/.test(f.path)
    );
    return hit ? { status: "ok", path: hit.path } : { status: "empty" };
  } catch {
    return { status: "error" };
  }
}

function parseGithubRepo(url) {
  const m = String(url || "").match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Clean a fetched text file. Some entries store UTF-16 (with \0 padding).
function cleanText(text) {
  if (!text) return "";
  return text.includes("\u0000") ? text.replace(/\u0000/g, "").trim() : text.trim();
}

// Official-entry metadata: SOURCE_URL (real repo), SUMMARY (module name),
// SCOPE (hooked package ids). All raw fetches, cached after the first fetch.
async function fetchOrgMeta(repo, prev) {
  // Reuse previously fetched metadata (rarely changes), unless it's corrupt.
  if (prev && prev.summary && !String(prev.summary).includes("\u0000")) {
    return {
      source_url: prev.source_url || "",
      summary: prev.summary,
      scope: Array.isArray(prev.scope) ? prev.scope : [],
    };
  }
  const [src, summary, scope] = await Promise.all([
    rawFetch(repo.full_name, "SOURCE_URL"),
    rawFetch(repo.full_name, "SUMMARY"),
    rawFetch(repo.full_name, "SCOPE"),
  ]);
  let scopeList = [];
  if (scope.ok) {
    try {
      scopeList = JSON.parse(scope.body);
      if (!Array.isArray(scopeList)) scopeList = [];
    } catch {
      scopeList = [];
    }
  }
  return {
    source_url: cleanText(src.body),
    summary: cleanText(summary.body),
    scope: scopeList.map(String),
  };
}

// Run fn over items with bounded concurrency, preserving order.
async function runPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);

  const existing = loadJson(DATA_FILE, []);
  const existingList = Array.isArray(existing) ? existing : [];
  const existingByKey = new Map(existingList.map((r) => [r.full_name, r]).filter(([k]) => k));
  let ignored = loadJson(IGNORED_FILE, {});
  if (!ignored || typeof ignored !== "object" || Array.isArray(ignored)) ignored = {};

  const final = new Map();
  const nowIso = new Date().toISOString();
  const ignoreTtlMs = args.ignoreTtlDays * 24 * 60 * 60 * 1000;

  // ---- Source 1: the official LSPosed module repository ----
  const orgBySource = new Map(); // "owner/repo" of SOURCE_URL -> official entry
  let orgCount = 0;
  if (!args.noOrg) {
    console.log(`Source 1: official LSPosed module repo (${ORG})...`);
    const orgRepos = await crawlOrgRepos(args.delay);
    const orgEntries = await runPool(orgRepos, CONCURRENCY, async (repo) => {
      const prev = existingByKey.get(repo.name);
      const meta = await fetchOrgMeta(repo, prev);
      return {
        full_name: repo.name, // package id, e.g. "com.chrxw.purenga"
        html_url: meta.source_url || repo.html_url,
        source_url: meta.source_url,
        org_repo: repo.full_name,
        summary: meta.summary || repo.description || "",
        description: meta.summary || repo.description || "",
        scope: meta.scope,
        archived: !!repo.archived,
        pushed_at: repo.pushed_at || "", // when the entry was last updated in the repo
        added_at: prev ? prev.added_at : undefined, // baseline entries are not "new"
        verified: true,
        source: "lsposed-repo",
      };
    });
    for (const entry of orgEntries) {
      final.set(entry.full_name, entry);
      orgCount++;
      const m = entry.source_url ? entry.source_url.match(/github\.com\/([^/]+\/[^/?#]+)/i) : null;
      if (m) orgBySource.set(m[1].toLowerCase(), entry);
    }
    // If the crawl was cut short (e.g. rate limit), keep official entries from
    // previous runs that this crawl didn't get to, so the list never shrinks.
    for (const repo of existingList) {
      if (repo.source === "lsposed-repo" && !final.has(repo.full_name)) {
        final.set(repo.full_name, repo);
      }
    }
    console.log(`  ${orgCount} official module entries`);
  }

  // ---- Source 2: GitHub search, verified against module markers ----
  console.log(`Source 2: searching GitHub (${args.queries.length} query/queries)...`);
  const candidates = [];
  let rateLimited = false;
  for (const query of args.queries) {
    const { found, stopped } = await searchRepositories(query, args.maxPages, args.delay);
    candidates.push(...found);
    if (stopped) {
      rateLimited = true;
      break;
    }
  }

  // Keep entries from previous runs that this run's search didn't return (e.g.
  // after a deeper crawl), and re-verify any pre-verification leftovers.
  const searchNames = new Set(candidates.map((c) => c.full_name.toLowerCase()));
  for (const repo of existingList) {
    if (!repo.full_name || repo.source === "lsposed-repo") continue; // org entries come from the crawl
    if (searchNames.has(repo.full_name.toLowerCase())) continue; // fresh search data will refresh it
    candidates.push({
      full_name: repo.full_name,
      owner: repo.owner || { login: "" },
      _existing: true,
      _verified: !!repo.verified,
    });
  }

  // Skip repos owned by the official org (already covered by the crawl).
  const seen = new Set();
  const toVerify = [];
  for (const repo of candidates) {
    if (!repo.full_name) continue;
    if (repo.owner && repo.owner.login && repo.owner.login.toLowerCase() === ORG.toLowerCase()) continue;
    if (seen.has(repo.full_name.toLowerCase())) continue;
    seen.add(repo.full_name.toLowerCase());
    toVerify.push(repo);
  }
  console.log(`  ${toVerify.length} unique candidates`);

  const results = await runPool(toVerify, CONCURRENCY, async (repo) => {
    const orgEntry = orgBySource.get(repo.full_name.toLowerCase());
    if (orgEntry) return { repo, verdict: "org" };

    const ignoredKey = repo.full_name.toLowerCase();
    const ign = ignored[ignoredKey];
    if (ign && ign.checked_at && Date.now() - new Date(ign.checked_at).getTime() < ignoreTtlMs) {
      return { repo, verdict: "ignored" };
    }

    // Already verified on a previous run: skip re-probing (stats still refresh).
    const prevEntry = existingByKey.get(repo.full_name);
    if (repo._verified || (prevEntry && prevEntry.verified)) {
      return {
        repo,
        verdict: "known",
        marker: prevEntry ? prevEntry.marker : null,
        metadata: prevEntry ? prevEntry.metadata : null,
      };
    }

    const probe = await probeRepo(repo.full_name);
    if (probe.verified) {
      return {
        repo,
        verdict: "verified",
        marker: probe.marker,
        metadata: parseMarkerBody(probe.body, probe.marker),
      };
    }
    if (process.env.GITHUB_TOKEN) {
      const tree = await treeCheck(repo);
      if (tree.verified) return { repo, verdict: "verified", marker: tree.marker, metadata: null };
    }
    return { repo, verdict: "rejected" };
  });

  let verified = 0;
  let rejected = 0;
  let merged = 0;
  let known = 0;
  for (const { repo, verdict, marker, metadata } of results) {
    if (verdict === "ignored") continue;
    if (verdict === "rejected") {
      ignored[repo.full_name.toLowerCase()] = { checked_at: nowIso };
      rejected++;
      continue;
    }

    const orgEntry = orgBySource.get(repo.full_name.toLowerCase());
    const prev = existingByKey.get(repo.full_name);
    let entry;
    if (orgEntry) {
      // Search found the real source repo of an official entry: merge the two.
      entry = {
        ...pickRepo(repo),
        package: orgEntry.full_name,
        summary: orgEntry.summary,
        scope: orgEntry.scope,
        org_repo: orgEntry.org_repo,
        source_url: orgEntry.source_url,
        verified: true,
        source: "lsposed-repo+search",
      };
      final.delete(orgEntry.full_name); // the bare official entry is upgraded
      merged++;
    } else if (repo._existing) {
      // Not in this run's search results: keep the stored entry as-is.
      entry = {
        ...prev,
        verified: true,
        source: prev && prev.source === "lsposed-repo+search" ? "lsposed-repo+search" : "search",
      };
    } else {
      entry = { ...pickRepo(repo), verified: true, source: "search" };
    }
    if (marker) entry.marker = marker;
    if (metadata && Object.keys(metadata).length) entry.metadata = metadata;
    entry.added_at = prev ? prev.added_at : nowIso;
    // Keep cached enrichment across refreshes (release data has its own TTL).
    if (prev && prev.release) entry.release = prev.release;
    if (prev && prev.release_fetched_at) entry.release_fetched_at = prev.release_fetched_at;
    if (prev && prev.release_checked_deep) entry.release_checked_deep = true;
    // First merge: carry the official entry's cached release over too.
    if (!entry.release && orgEntry && orgEntry.release) {
      entry.release = orgEntry.release;
      entry.release_fetched_at = entry.release_fetched_at || orgEntry.release_fetched_at;
      if (orgEntry.release_checked_deep) entry.release_checked_deep = true;
    }
    if (verdict === "known") known++;
    final.set(entry.full_name, entry);
    verified++;
  }

  // ---- Framework API metadata refresh ----
  // Fetch minApi/maxApi from module.prop/module.json for entries that don't
  // have it yet. The real source repo is probed: the repo itself for
  // search/merged entries, SOURCE_URL for pure official entries. Common paths
  // are free raw fetches; when a token (or --api-scan) is present, repos that
  // miss every path get a git-tree scan to find module.prop anywhere (catches
  // the libxposed META-INF/xposed layout). Cached with a 30-day TTL so
  // no-API modules aren't re-probed every run.
  const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const treeScan = !!process.env.GITHUB_TOKEN || args.apiScan > 0;
  const treeBudget = treeScan ? (process.env.GITHUB_TOKEN ? 2000 : args.apiScan) : 0;
  const metaJobs = [];
  const metaJobByKey = new Map(); // lowercase repo -> { repoRef, entries: [] }
  for (const entry of final.values()) {
    const prev = existingByKey.get(entry.full_name);
    const hasApi =
      entry.metadata &&
      (entry.metadata.minApi !== undefined ||
        entry.metadata.maxApi !== undefined ||
        entry.metadata.targetApi !== undefined);
    if (hasApi) continue;
    const checkedAt = entry.metadata_checked_at || (prev && prev.metadata_checked_at);
    // --api-scan is an explicit request: ignore the TTL and scan now.
    if (checkedAt && !args.apiScan && Date.now() - new Date(checkedAt).getTime() < META_TTL_MS) {
      continue;
    }
    const repoRef =
      entry.source === "lsposed-repo"
        ? (entry.source_url ? parseGithubRepo(entry.source_url) : null)
        : entry.full_name;
    if (!repoRef) {
      entry.metadata_checked_at = nowIso;
      continue;
    }
    const key = repoRef.toLowerCase();
    let job = metaJobByKey.get(key);
    if (!job) {
      job = { repoRef, entries: [], stars: entry.stargazers_count || 0 };
      metaJobByKey.set(key, job);
      metaJobs.push(job);
    }
    job.entries.push(entry);
    if ((entry.stargazers_count || 0) > job.stars) job.stars = entry.stargazers_count || 0;
  }
  // Scan the most popular repos first so a limited tree-scan budget goes to
  // the modules people actually see.
  metaJobs.sort((a, b) => b.stars - a.stars);
  let metaRefreshed = 0;
  let metaScans = 0;
  await runPool(metaJobs, CONCURRENCY, async (job) => {
    let m = await probeModuleMeta(job.repoRef);
    // Only cache the "no API info" state when we're confident there is none:
    // a failed scan (rate limited / truncated / network error) or an exhausted
    // scan budget must not stamp metadata_checked_at, so it retries next run.
    let cacheable = true;
    if (!m && treeScan) {
      if (metaScans < treeBudget) {
        metaScans++;
        const scan = await findModulePropInTree(job.repoRef);
        if (scan.status === "ok") {
          const r = await rawFetch(job.repoRef, scan.path);
          if (r.ok) m = parseMarkerBody(r.body, scan.path);
        } else if (scan.status !== "empty") {
          cacheable = false; // ratelimited / truncated / error -> retry later
        }
      } else {
        cacheable = false; // scan budget exhausted -> retry next run
      }
    }
    for (const entry of job.entries) {
      if (m) {
        entry.metadata = { ...(entry.metadata || {}), ...m };
        metaRefreshed++;
      }
      if (cacheable) entry.metadata_checked_at = new Date().toISOString();
    }
  });
  console.log(`  API metadata refreshed for ${metaRefreshed} modules (${metaScans} tree scans)`);

  // Sort: real repos by stars (desc), official-only entries (no star count)
  // sink to the bottom, then alphabetically.
  const sorted = [...final.values()].sort((a, b) => {
    const sa = typeof a.stargazers_count === "number" ? a.stargazers_count : -1;
    const sb = typeof b.stargazers_count === "number" ? b.stargazers_count : -1;
    if (sb !== sa) return sb - sa;
    return (a.full_name || "").localeCompare(b.full_name || "");
  });

  // ---- Latest release info (cached, re-fetched after --release-ttl-days) ----
  // Gives the useful bits: version tag, publish date, and an APK download link.
  let releaseStopped = false;
  let releasedCount = 0;
  const releaseTtlMs = args.releaseTtlDays * 24 * 60 * 60 * 1000;
  const all = await runPool(sorted, CONCURRENCY, async (entry) => {
    if (releaseStopped) return entry;
    // Cache both the "has release" and "no release" states (release_fetched_at).
    // Only honor the cache once a release has been DEEP-checked (release_checked_deep):
    // older entries were shallow-scanned (latest release only) and may hide an APK
    // in an earlier release, so they get re-fetched once with the new scan.
    if (
      entry.release_checked_deep &&
      entry.release_fetched_at &&
      Date.now() - new Date(entry.release_fetched_at).getTime() < releaseTtlMs
    ) {
      if (entry.release && entry.release.tag) releasedCount++;
      return entry;
    }
    const repoRef = entry.org_repo || entry.full_name;
    const url = new URL(`https://api.github.com/repos/${repoRef}/releases`);
    url.searchParams.set("per_page", "10");
    const res = await githubGet(url);
    if (!res) return entry;
    if (!res.ok) {
      if (res.rateLimited) {
        releaseStopped = true;
        quietWarnings = true;
      }
      return entry;
    }
    let list = [];
    try {
      list = await res.json();
    } catch {
      return entry;
    }
    const fetchedAt = new Date().toISOString();
    if (!Array.isArray(list) || list.length === 0) {
      return { ...entry, release: null, release_fetched_at: fetchedAt };
    }
    // Pick the NEWEST release that actually carries an .apk asset. The latest
    // release is often a docs-only/zip tag, so a shallow scan would report
    // "no APK" even though an earlier release ships the module.
    const isApkAsset = (a) => /\.apk$/i.test((a && a.name) || "");
    const r = list.find((x) => (x.assets || []).some(isApkAsset)) || list[0];
    const apk = (r.assets || []).find(isApkAsset);
    const release = {
      tag: r.tag_name || "",
      name: r.name || "",
      published_at: r.published_at || "",
      html_url: r.html_url || "",
      // Only ever point at a real .apk asset (never a zip/source fallback).
      apk_url: apk ? apk.browser_download_url : "",
      prerelease: !!r.prerelease,
    };
    releasedCount++;
    return {
      ...entry,
      release,
      release_fetched_at: fetchedAt,
      release_checked_deep: true,
    };
  });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2) + "\n");
  fs.writeFileSync(IGNORED_FILE, JSON.stringify(ignored, null, 2) + "\n");

  const newCount = [...final.keys()].filter((k) => !existingByKey.has(k)).length;
  console.log("");
  console.log(`Official entries: ${orgCount}`);
  console.log(`Verified from search: ${verified} (${known} kept from cache, ${merged} merged with official entries)`);
  console.log(`Rejected (not modules): ${rejected}`);
  console.log(`Ignored cache: ${Object.keys(ignored).length} repos (re-checked after ${args.ignoreTtlDays}d)`);
  console.log(`Release info: ${releasedCount} of ${all.length} modules`);
  console.log(`Total modules: ${all.length} (had ${existingList.length}, +${newCount} new)`);
  console.log(`Wrote ${DATA_FILE} and ${IGNORED_FILE}`);
  if (rateLimited) {
    console.warn(
      "Note: GitHub API rate limit hit; the list may be incomplete. Set GITHUB_TOKEN for higher limits and full git-tree verification."
    );
  }
  if (releaseStopped) {
    console.warn(
      "Note: rate-limited while fetching release info; entries keep their cached release data and are retried on the next run."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
