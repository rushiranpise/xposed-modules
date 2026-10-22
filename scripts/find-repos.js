#!/usr/bin/env node
"use strict";

/**
 * Build a curated list of Xposed/LSPosed module repositories.
 *
 * Usage:
 *   node scripts/find-repos.js [--max-pages N] [--delay MS] [--queries "q1|q2"] [--no-org] [--ignore-ttl-days N] [--release-ttl-days N] [--api-scan N] [--package-retry-days N] [--no-package-scan]
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
const zlib = require("zlib");

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
  "topic:lsposed",
  "topic:libxposed",
  "topic:xposed",
  '"xposed module" in:name,description',
  '"xposed-module" in:name,description',
];

const DEFAULT_MAX_PAGES = 10; // pages per query; 100 repos per page, API caps at 1000/query
const DEFAULT_DELAY_MS = 2500; // stays under GitHub's 30 searches per minute
const DEFAULT_IGNORE_TTL_DAYS = 30; // re-check rejected candidates after this long
const DEFAULT_RELEASE_TTL_DAYS = 7; // re-fetch latest release info after this long
const DEFAULT_PACKAGE_RETRY_DAYS = 7; // re-probe APK manifests that could not be read
const CONCURRENCY = 24; // parallel fetches for verification / metadata
const PACKAGE_CONCURRENCY = 8; // parallel APK manifest probes (small range requests)

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
    packageRetryDays: DEFAULT_PACKAGE_RETRY_DAYS,
    packageScan: true,
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
      case "--package-retry-days":
        args.packageRetryDays = parseInt(argv[++i], 10) || DEFAULT_PACKAGE_RETRY_DAYS;
        break;
      case "--no-package-scan":
        args.packageScan = false;
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

// githubGet with a few backoff retries for network errors and 5xx responses.
async function githubGetWithRetry(url, attempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await githubGet(url);
    if (res && (res.ok || res.rateLimited || res.status === 404)) return res;
    last = res;
    if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
  }
  return last;
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

// ---- Package ids from release APKs -----------------------------------------
// Search-found repos carry no package id: only the official org puts it in the
// repo name. The APK always does, inside its binary AndroidManifest.xml, so
// read that entry straight out of the ZIP with a few small range requests
// instead of downloading the whole APK. Successful results are stored forever;
// failures are retried after --package-retry-days.

const PACKAGE_ID_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
// Only relevant when a CDN ignores Range and would send the whole APK.
const MAX_APK_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const RANGE_TIMEOUT_MS = 20000;

function u16(buf, off) {
  return buf.readUInt16LE(off);
}

function u32(buf, off) {
  return buf.readUInt32LE(off);
}

function isPackageId(value) {
  return typeof value === "string" && PACKAGE_ID_RE.test(value);
}

async function rangeGet(url, start, end) {
  const res = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}`, "User-Agent": "xposed-modules-directory" },
    redirect: "follow",
    signal: AbortSignal.timeout(RANGE_TIMEOUT_MS),
  });
  const contentRange = res.headers.get("content-range") || "";
  const totalMatch = contentRange.match(/\/(\d+)$/);
  if (res.status === 206) {
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      total: totalMatch ? Number(totalMatch[1]) : null,
    };
  }
  if (res.status === 200) {
    // Range was ignored. Small APKs are still fine; large ones are not worth it.
    const length = Number(res.headers.get("content-length") || 0);
    if (length > MAX_APK_DOWNLOAD_BYTES) {
      await res.body?.cancel();
      throw new Error("server ignored Range");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf.subarray(start, Math.min(end + 1, buf.length)), total: buf.length };
  }
  throw new Error(`HTTP ${res.status}`);
}

async function rangeGetWithRetry(url, start, end, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await rangeGet(url, start, end);
    } catch (error) {
      lastError = error;
      const message = String(error.message || "");
      // 4xx other than 429 will not change on a retry.
      if (/^HTTP 4\d\d$/.test(message) && !message.includes("429")) break;
      if (attempt < attempts - 1) await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === 0x06054b50) return i;
  }
  return -1;
}

// Finds the ZIP entry for AndroidManifest.xml in a central directory buffer.
function findManifestEntry(cd) {
  let p = 0;
  while (p + 46 <= cd.length && u32(cd, p) === 0x02014b50) {
    const method = u16(cd, p + 10);
    const compSize = u32(cd, p + 20);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const localOffset = u32(cd, p + 42);
    const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === "AndroidManifest.xml") return { method, compSize, localOffset };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function parseStringPool(buf, start) {
  const stringCount = u32(buf, start + 8);
  const flags = u32(buf, start + 16);
  const stringsStart = u32(buf, start + 20);
  const utf8 = (flags & 0x100) !== 0;
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const off = u32(buf, start + 28 + i * 4);
    let p = start + stringsStart + off;
    if (utf8) {
      let len = buf[p++];
      if (len & 0x80) len = ((len & 0x7f) << 8) | buf[p++];
      let byteLen = buf[p++];
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | buf[p++];
      strings.push(buf.toString("utf8", p, p + byteLen));
    } else {
      let len = u16(buf, p);
      p += 2;
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | u16(buf, p);
        p += 2;
      }
      strings.push(buf.toString("utf16le", p, p + len * 2));
    }
  }
  return strings;
}

// Pulls the package attribute out of a binary AndroidManifest.xml.
function readPackageFromManifest(buf) {
  if (buf.length < 8 || u16(buf, 0) !== 0x0003) return null;
  let off = 8;
  let pool = null;
  while (off + 8 <= buf.length) {
    const type = u16(buf, off);
    const size = u32(buf, off + 4);
    if (size < 8 || off + size > buf.length) break;
    if (type === 0x0001) {
      pool = parseStringPool(buf, off);
    } else if (type === 0x0102 && pool) {
      const elementName = pool[u32(buf, off + 20)];
      if (elementName === "manifest") {
        const attrStart = u16(buf, off + 24);
        const attrSize = u16(buf, off + 26);
        const attrCount = u16(buf, off + 28);
        for (let i = 0; i < attrCount; i++) {
          const attr = off + 16 + attrStart + i * attrSize;
          if (attr + 20 > buf.length) break;
          if (pool[u32(buf, attr + 4)] !== "package") continue;
          const raw = u32(buf, attr + 8);
          const dataType = buf.readUInt8(attr + 15);
          const data = u32(buf, attr + 16);
          const value = raw !== 0xffffffff ? pool[raw] : dataType === 3 ? pool[data] : null;
          return isPackageId(value) ? value : null;
        }
      }
    }
    off += size;
  }
  return null;
}

async function readApkPackage(apkUrl) {
  const head = await rangeGetWithRetry(apkUrl, 0, 0);
  if (!head.total) throw new Error("APK size unknown");

  const tailStart = Math.max(0, head.total - 65536);
  const tail = await rangeGetWithRetry(apkUrl, tailStart, head.total - 1);
  const eocd = findEocd(tail.buffer);
  if (eocd < 0) throw new Error("ZIP end record not found");
  const cdSize = u32(tail.buffer, eocd + 12);
  const cdOffset = u32(tail.buffer, eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error("ZIP64 APK");
  if (cdSize <= 0 || cdOffset + cdSize > head.total) throw new Error("invalid ZIP directory");

  const cd = await rangeGetWithRetry(apkUrl, cdOffset, cdOffset + cdSize - 1);
  const manifest = findManifestEntry(cd.buffer);
  if (!manifest) throw new Error("AndroidManifest.xml not found");

  const localHeaderEnd = manifest.localOffset + 30 + 4096;
  const header = await rangeGetWithRetry(apkUrl, manifest.localOffset, localHeaderEnd);
  if (u32(header.buffer, 0) !== 0x04034b50) throw new Error("invalid ZIP entry header");
  const nameLen = u16(header.buffer, 26);
  const extraLen = u16(header.buffer, 28);
  const dataStart = manifest.localOffset + 30 + nameLen + extraLen;
  if (manifest.compSize <= 0) throw new Error("empty AndroidManifest.xml");

  const packed = await rangeGetWithRetry(apkUrl, dataStart, dataStart + manifest.compSize - 1);
  let xml;
  if (manifest.method === 0) {
    xml = packed.buffer;
  } else if (manifest.method === 8) {
    xml = zlib.inflateRawSync(packed.buffer);
  } else {
    throw new Error(`unsupported compression method ${manifest.method}`);
  }
  if (xml.length > MAX_MANIFEST_BYTES) throw new Error("AndroidManifest.xml is unexpectedly large");
  return readPackageFromManifest(xml);
}

// The package id an entry resolves to: explicit `package`, or the official
// org repo name for entries that came from the LSPosed repository.
function packageIdOf(entry) {
  if (isPackageId(entry.package)) return entry.package;
  const orgRepo = entry.org_repo || "";
  if (orgRepo.startsWith(`${ORG}/`)) {
    const pkg = orgRepo.slice(ORG.length + 1);
    if (isPackageId(pkg)) return pkg;
  }
  return null;
}

// Official entries already expose the package through org_repo, which consumers
// read directly. Only search-found repos need it read out of the APK.
function hasKnownPackage(entry) {
  return packageIdOf(entry) !== null;
}

async function fillMissingPackages(entries, args) {
  const retryMs = args.packageRetryDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const candidates = entries.filter((entry) => {
    if (hasKnownPackage(entry)) return false;
    if (!entry.release || !entry.release.apk_url) return false;
    const checkedAt = entry.package_checked_at ? new Date(entry.package_checked_at).getTime() : 0;
    return !checkedAt || now - checkedAt >= retryMs;
  });
  if (candidates.length === 0) return;

  let resolved = 0;
  let failed = 0;
  let probed = 0;
  const failures = [];
  await runPool(candidates, PACKAGE_CONCURRENCY, async (entry) => {
    try {
      const pkg = await readApkPackage(entry.release.apk_url);
      if (pkg) {
        entry.package = pkg;
        delete entry.package_checked_at;
        resolved++;
      } else {
        entry.package_checked_at = new Date().toISOString();
        failures.push(`${entry.full_name}: no package attribute`);
        failed++;
      }
    } catch (error) {
      entry.package_checked_at = new Date().toISOString();
      failures.push(`${entry.full_name}: ${error.message}`);
      failed++;
    }
    probed++;
    if (probed % 100 === 0) console.log(`  ... ${probed}/${candidates.length} APKs probed`);
  });
  console.log(`  Package ids from APK manifests: ${resolved} resolved, ${failed} unreadable (${candidates.length} probed)`);
  if (failures.length > 0) console.log(`  Unreadable: ${failures.slice(0, 5).join("; ")}`);
}

// ---- Merge entries that share a package id --------------------------------
// The official org and GitHub search can both find the same module. The app
// already collapses them by package; doing it here keeps the site to one card
// per module and keeps the data file from carrying both identities.

function entryTime(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : 0;
}

// Real source repos are preferred over package-only official entries, and a
// merged official+search entry is already the best of both.
function entryScore(entry) {
  const source = entry.source || "";
  let score = 0;
  if (source.includes("search")) score += 4;
  if (source.startsWith("lsposed-repo")) score += 2;
  if (!entry.archived) score += 1;
  return score;
}

function mergePackageGroup(pkg, group) {
  const primary = [...group].sort((a, b) => {
    const byScore = entryScore(b) - entryScore(a);
    if (byScore !== 0) return byScore;
    const byRelease = entryTime(b.release && b.release.published_at) -
      entryTime(a.release && a.release.published_at);
    if (byRelease !== 0) return byRelease;
    return (b.stargazers_count || 0) - (a.stargazers_count || 0);
  })[0];
  const official = group.find((entry) => (entry.source || "").startsWith("lsposed-repo"));
  const merged = { ...primary, package: pkg };

  if (official && official !== primary) {
    if (!merged.summary && official.summary) merged.summary = official.summary;
    if (!merged.description && official.description) merged.description = official.description;
    if (!merged.homepage && official.homepage) merged.homepage = official.homepage;
    if (!merged.source_url && official.source_url) merged.source_url = official.source_url;
    if (!merged.org_repo && official.org_repo) merged.org_repo = official.org_repo;
    if ((!merged.scope || merged.scope.length === 0) && official.scope && official.scope.length) {
      merged.scope = official.scope;
    }
    const metadata = { ...(official.metadata || {}), ...(merged.metadata || {}) };
    if (Object.keys(metadata).length > 0) merged.metadata = metadata;
  }
  if (official && (primary.source || "").includes("search")) {
    merged.source = "lsposed-repo+search";
  }
  merged.verified = group.some((entry) => entry.verified);

  // Keep the newest release that actually has an APK, matching what the app
  // would pick from the duplicate entries.
  const newest = group
    .filter((entry) => entry.release && entry.release.apk_url)
    .sort((a, b) => entryTime(b.release.published_at) - entryTime(a.release.published_at))[0];
  if (
    newest &&
    (!merged.release ||
      !merged.release.apk_url ||
      entryTime(newest.release.published_at) > entryTime(merged.release.published_at))
  ) {
    merged.release = newest.release;
    merged.release_fetched_at = newest.release_fetched_at;
    merged.release_checked_deep = newest.release_checked_deep;
  }

  const added = group.map((entry) => entryTime(entry.added_at)).filter((t) => t > 0);
  if (added.length > 0) merged.added_at = new Date(Math.min(...added)).toISOString();
  return merged;
}

function mergeDuplicatePackages(entries) {
  const byPackage = new Map();
  const result = [];
  for (const entry of entries) {
    const pkg = packageIdOf(entry);
    if (!pkg) {
      result.push(entry);
      continue;
    }
    const group = byPackage.get(pkg);
    if (group) group.push(entry);
    else byPackage.set(pkg, [entry]);
  }

  let mergedAway = 0;
  for (const [pkg, group] of byPackage) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    mergedAway += group.length - 1;
    result.push(mergePackageGroup(pkg, group));
  }
  if (mergedAway > 0) {
    console.log(
      `  Merged ${mergedAway} duplicate entries into ${byPackage.size} package cards`
    );
  }
  // Keep the file in the same star-descending order the collector writes elsewhere.
  result.sort((a, b) => {
    const sa = typeof a.stargazers_count === "number" ? a.stargazers_count : -1;
    const sb = typeof b.stargazers_count === "number" ? b.stargazers_count : -1;
    if (sb !== sa) return sb - sa;
    return (a.full_name || "").localeCompare(b.full_name || "");
  });
  return result;
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

const isApkAsset = (asset) => /\.apk$/i.test((asset && asset.name) || "");

// Fetches the newest release that carries an APK, plus the raw result state so
// the caller can tell a repo with no releases from a transient request failure.
async function fetchLatestRelease(entry) {
  const repoRef = entry.org_repo || entry.full_name;
  const url = new URL(`https://api.github.com/repos/${repoRef}/releases`);
  url.searchParams.set("per_page", "10");
  const res = await githubGetWithRetry(url);
  if (!res) return { status: "retry" };
  if (!res.ok) {
    if (res.rateLimited) return { status: "ratelimited" };
    if (res.status === 404) {
      return { status: "ok", fetchedAt: new Date().toISOString(), release: null };
    }
    return { status: "retry" };
  }
  let list;
  try {
    list = await res.json();
  } catch {
    return { status: "retry" };
  }
  if (!Array.isArray(list)) return { status: "retry" };

  const fetchedAt = new Date().toISOString();
  if (list.length === 0) return { status: "ok", fetchedAt, release: null };

  // Pick the NEWEST release that actually carries an .apk asset. The latest
  // release is often a docs-only/zip tag, so a shallow scan would report
  // "no APK" even though an earlier release ships the module.
  const release = list.find((x) => (x.assets || []).some(isApkAsset)) || list[0];
  const apk = (release.assets || []).find(isApkAsset);
  return {
    status: "ok",
    fetchedAt,
    release: {
      tag: release.tag_name || "",
      name: release.name || "",
      published_at: release.published_at || "",
      html_url: release.html_url || "",
      // Only ever point at a real .apk asset (never a zip/source fallback).
      apk_url: apk ? apk.browser_download_url : "",
      prerelease: !!release.prerelease,
    },
  };
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
        updated_at: repo.updated_at || "",
        stargazers_count: repo.stargazers_count ?? null,
        language: repo.language || null,
        owner: repo.owner || null,
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
  const releaseRetry = [];
  const all = await runPool(sorted, CONCURRENCY, async (entry) => {
    if (releaseStopped) return entry;
    // Only a release that actually ships an APK is cached. An entry with no
    // release, or with releases that carry no APK, stays un-deep and is checked
    // again next run, so a module published later is picked up without waiting
    // out the TTL. A failed request is retried once below.
    if (
      entry.release_checked_deep &&
      entry.release &&
      entry.release.apk_url &&
      entry.release_fetched_at &&
      Date.now() - new Date(entry.release_fetched_at).getTime() < releaseTtlMs
    ) {
      releasedCount++;
      return entry;
    }
    const result = await fetchLatestRelease(entry);
    if (result.status === "ratelimited") {
      releaseStopped = true;
      quietWarnings = true;
      return entry;
    }
    if (result.status !== "ok") {
      releaseRetry.push(entry);
      return entry;
    }
    if (result.release && result.release.apk_url) releasedCount++;
    return {
      ...entry,
      release: result.release,
      release_fetched_at: result.fetchedAt,
      release_checked_deep: !!(result.release && result.release.apk_url),
    };
  });

  // Second look at entries whose request failed (network, 5xx) rather than
  // leaving them without a release until tomorrow's run.
  if (!releaseStopped && releaseRetry.length > 0) {
    console.log(`  Retrying ${releaseRetry.length} release lookups that failed...`);
    await sleep(3000);
    await runPool(releaseRetry, 8, async (entry) => {
      if (releaseStopped) return;
      const result = await fetchLatestRelease(entry);
      if (result.status === "ratelimited") {
        releaseStopped = true;
        quietWarnings = true;
        return;
      }
      if (result.status !== "ok") return;
      if (result.release && result.release.apk_url) releasedCount++;
      entry.release = result.release;
      entry.release_fetched_at = result.fetchedAt;
      entry.release_checked_deep = !!(result.release && result.release.apk_url);
    });
  }

  // ---- Package ids for search-found repos ----
  // Official entries already carry the package in their repo name. Everything
  // else gets it from the release APK's manifest.
  if (args.packageScan) {
    await fillMissingPackages(all, args);
  }

  // One card per package: the site and the app both key modules by package id.
  const mergedModules = mergeDuplicatePackages(all);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(mergedModules, null, 2) + "\n");
  fs.writeFileSync(IGNORED_FILE, JSON.stringify(ignored, null, 2) + "\n");

  const newCount = [...final.keys()].filter((k) => !existingByKey.has(k)).length;
  console.log("");
  console.log(`Official entries: ${orgCount}`);
  console.log(`Verified from search: ${verified} (${known} kept from cache, ${merged} merged with official entries)`);
  console.log(`Rejected (not modules): ${rejected}`);
  console.log(`Ignored cache: ${Object.keys(ignored).length} repos (re-checked after ${args.ignoreTtlDays}d)`);
  const releasedCards = mergedModules.filter(
    (entry) => entry.release && entry.release.apk_url
  ).length;
  console.log(`Release info: ${releasedCards} of ${mergedModules.length} modules`);
  console.log(`Total modules: ${mergedModules.length} (had ${existingList.length}, +${newCount} new)`);
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

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  readApkPackage,
  readPackageFromManifest,
  fetchLatestRelease,
  mergeDuplicatePackages,
  packageIdOf,
};
