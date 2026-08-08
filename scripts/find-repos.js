#!/usr/bin/env node
"use strict";

/**
 * Find Xposed module repositories on GitHub and maintain a persistent list.
 *
 * Usage:
 *   node scripts/find-repos.js [--max-pages N] [--delay MS] [--queries "q1|q2|q3"]
 *
 * What it does:
 *   1. Reads the existing list from data/repos.json (created if missing).
 *   2. Queries the GitHub repository search API with the queries below
 *      (by topic and by name/description).
 *   3. Merges results into the list, deduped by full_name, so repos that
 *      were already found on a previous run are NEVER added again — only
 *      new repos are appended (each gets an `added_at` timestamp).
 *   4. Writes the merged, star-sorted list back to data/repos.json.
 *
 * Set the GITHUB_TOKEN env var to authenticate (raises the search rate
 * limit from 10 to 30 requests/minute). GitHub Actions passes its token
 * automatically via the workflow.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "repos.json");

// GitHub search syntax. Edit these to widen/narrow what gets collected.
const DEFAULT_QUERIES = [
  "topic:xposed-module",
  "topic:xposed",
  '"xposed module" in:name,description',
  '"xposed-module" in:name,description',
];

const DEFAULT_MAX_PAGES = 5; // pages per query; 100 repos per page, API caps at 1000/query
const DEFAULT_DELAY_MS = 1500; // politeness delay between API requests

function parseArgs(argv) {
  const args = { queries: DEFAULT_QUERIES, maxPages: DEFAULT_MAX_PAGES, delay: DEFAULT_DELAY_MS };
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
      default:
        console.warn(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Only exclude forks when the query doesn't already say something about forks.
function withNoForks(query) {
  return /\bfork:/i.test(query) ? query : `${query} fork:false`;
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

    let res;
    try {
      res = await fetch(url, { headers: requestHeaders() });
    } catch (err) {
      console.warn(`  Network error on page ${page}: ${err.message}`);
      break;
    }

    if (!res.ok) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 403 || res.status === 429) {
        console.warn(
          `  Rate limited (HTTP ${res.status}), remaining requests: ${remaining ?? "?"}`
        );
        if (remaining === "0") return { found, stopped: true };
        // Secondary rate limit: wait a bit and retry this page once.
        console.warn("  Waiting 30s and retrying once...");
        await sleep(30_000);
        try {
          res = await fetch(url, { headers: requestHeaders() });
        } catch (err) {
          console.warn(`  Network error on retry for page ${page}: ${err.message}`);
          break;
        }
        if (!res.ok) {
          console.warn(`  Still rate limited on retry (HTTP ${res.status}); moving on.`);
          break;
        }
      } else {
        console.warn(
          `  GitHub API error ${res.status} for "${query}" (page ${page}): ${res.statusText}`
        );
        break;
      }
    }

    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) break;
    found.push(...items.map(pickRepo));

    const total = body.total_count ?? 0;
    console.log(`  [${query}] page ${page}: ${items.length} repos (${total} match in total)`);

    // Stop when we have everything the API offers for this query.
    if (found.length >= total || items.length < 100) break;
    if (delay > 0) await sleep(delay);
  }
  return { found, stopped: false };
}

async function main() {
  const args = parseArgs(process.argv);

  let existing = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch (err) {
      console.warn(`Could not parse ${DATA_FILE}; starting fresh: ${err.message}`);
      existing = [];
    }
  }

  // Map of known repos so we never re-add the same repository.
  const known = new Map(existing.map((repo) => [repo.full_name, repo]));

  console.log(`Searching GitHub for Xposed module repos (${args.queries.length} query/queries)...`);
  let rateLimited = false;
  for (const query of args.queries) {
    const { found, stopped } = await searchRepositories(query, args.maxPages, args.delay);
    let added = 0;
    for (const repo of found) {
      const previous = known.get(repo.full_name);
      if (previous) {
        // Known repo: refresh stats/metadata but keep the original added_at date.
        known.set(repo.full_name, { ...repo, added_at: previous.added_at || repo.added_at });
      } else {
        repo.added_at = new Date().toISOString();
        known.set(repo.full_name, repo);
        added++;
      }
    }
    console.log(`  -> ${added} new repo(s) from "${query}"`);
    if (stopped) {
      rateLimited = true;
      break;
    }
  }

  const all = [...known.values()].sort((a, b) => b.stargazers_count - a.stargazers_count);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2) + "\n");

  console.log("");
  console.log(`Total repos: ${all.length} (had ${existing.length}, added ${all.length - existing.length})`);
  console.log(`Wrote ${DATA_FILE}`);
  if (rateLimited) {
    console.warn(
      "Note: hit the GitHub API rate limit; the list may be incomplete. Set GITHUB_TOKEN for higher limits."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
