# Xposed Modules Directory

> Mega collection of Xposed & LSPosed modules of all time — updated daily.

A curated, automatically-maintained directory of **Xposed / LSPosed module repositories**. It is built from GitHub data every day by a GitHub Actions workflow and published to GitHub Pages.

**Live site:** <https://rushiranpise.github.io/xposed-modules/>

## What this repo does

Two things run automatically in [GitHub Actions](https://github.com/rushiranpise/xposed-modules/actions) (daily at 03:00 UTC, plus on every push and manual trigger):

1. **Discover & verify** — [`scripts/find-repos.js`](scripts/find-repos.js) crawls GitHub and produces the curated list in [`data/repos.json`](data/repos.json).
2. **Build & deploy** — [`scripts/build-site.js`](scripts/build-site.js) renders the static site from that data into [`site/index.html`](site/index.html), which is deployed to GitHub Pages.

Only **new** modules are added on each run — already-known repos are never duplicated, so the list grows over time instead of churning.

## Where the list comes from

Modules are collected from two sources:

### 1. The official LSPosed module repository

The [`Xposed-Modules-Repo`](https://github.com/Xposed-Modules-Repo) GitHub org — the same curated data that powers [modules.lsposed.org](https://modules.lsposed.org/). Every repo there is a module entry:

- the repo name is the module's **package id**
- `SUMMARY` holds the module name
- `SOURCE_URL` points to the real source repository
- `SCOPE` lists the packages the module hooks

These are tagged **Official** on the site. Search-found repos whose package id matches an official entry inherit the official badge too.

### 2. GitHub search + verification

GitHub search finds modules that are **not** in the official repository. Every candidate is verified as a real module by probing for the marker files Xposed/LSPosed actually require in the source:

| Marker | Meaning |
| --- | --- |
| `xposed_init` | classic Xposed entry point |
| `module.prop` | LSPosed module properties |
| `module.json` | LSPosed module repo format |

Marker paths are probed via `raw.githubusercontent.com` (free — does not count against API rate limits). When `GITHUB_TOKEN` is set (the workflow passes it automatically), candidates that miss every probe get a full git-tree scan, which catches modules with unusual directory layouts.

Candidates that fail verification go into `data/ignored.json` so they are not re-checked on every run (the file is generated, not committed).

## Current stats

Stats are computed live from [`data/repos.json`](data/repos.json) on each build:

- **1,622** verified modules
- ~934 from the official LSPosed repo, ~688 discovered via search
- **149** archived, the rest active
- **141** declare a libxposed `targetApi` level (e.g. 102, 93) — filterable on the site

## The site

The site features:

- **Filters**: All / Official / Unofficial · Active / Archived · libxposed API level (102+, 93+, no info)
- **Sorting**: updated · stars · name · release · added
- **Cards**: avatar, owner · package id, description, version + libxposed API + released date, tags, stars, badges
- **Download**: links the newest release that actually ships an `.apk` (releases with only zips/tarballs fall back to a "View release" link)
- **Search** across names, owners, and package ids
- Responsive layout for phones and desktops

The GitHub Actions workflow also builds a companion **Xposed Store** Android app's data source — the app fetches `data/repos.json` directly from this repo.

## Running locally

Requires Node.js 18+.

```bash
# 1. Crawl & update the module list (needs a GITHUB_TOKEN for full scans)
GITHUB_TOKEN=your_token node scripts/find-repos.js

# 2. Build the site
node scripts/build-site.js
```

`find-repos.js` accepts options:

```
node scripts/find-repos.js [--max-pages N] [--delay MS] [--queries "q1|q2"]
                            [--no-org] [--ignore-ttl-days N] [--release-ttl-days N]
                            [--api-scan N]
```

- `--no-org` — skip the official org crawl
- `--ignore-ttl-days` — days before a failed candidate is re-checked (default: 30)
- `--release-ttl-days` — days before a cached release is refreshed (default: 1)
- `--api-scan N` — re-scan module API metadata for `N` repos per run
- `--queries` — override the default GitHub search queries

## Data format

[`data/repos.json`](data/repos.json) is a plain JSON array of module objects. Key fields:

| Field | Description |
| --- | --- |
| `full_name` / `html_url` | repository identity |
| `description`, `language`, `topics` | repo metadata |
| `stargazers_count`, `forks_count` | popularity |
| `archived` | whether the repo is archived |
| `owner` | owner login + avatar url |
| `pushed_at`, `updated_at`, `created_at` | activity timestamps |
| `verified` | true once marker verification passed |
| `source` | `lsposed-repo`, `search`, or `lsposed-repo+search` |
| `marker` | which marker was found (`xposed_init` / `module.prop` / `module.json`) |
| `scope` | package ids the module hooks |
| `added_at` | when this repo was first added to the list |
| `metadata` | parsed `module.prop` info: name, version, versionCode, author, `minApi`, `targetApi` |
| `release` | newest APK-bearing release: tag, name, `published_at`, `html_url`, `apk_url` |

## Contributing

Spot a module that should be here? It will be picked up automatically by the daily search. Want it excluded? Add the repo's package id to the ignored list in the crawler. Found a bug? Open an issue.

## License

This repository contains **data only** — repo metadata fetched from the GitHub API. All module code belongs to its respective authors; the directory itself is just an index.
