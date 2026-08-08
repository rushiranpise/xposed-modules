# Xposed Modules Directory

A GitHub Actions–powered static website listing **actual Xposed/LSPosed module repositories** — not just anything tagged "xposed" — kept up to date automatically.

## How it works

The list in [`data/repos.json`](data/repos.json) is built from two sources:

### 1. The official LSPosed module repository (modules.lsposed.org)
[`scripts/find-repos.js`](scripts/find-repos.js) crawls the [`Xposed-Modules-Repo`](https://github.com/Xposed-Modules-Repo) GitHub org — the same curated data that powers [modules.lsposed.org](https://modules.lsposed.org/). Every repo in that org is a real module entry:

| File | Meaning |
| --- | --- |
| repo name | the module's package id (e.g. `com.chrxw.purenga`) |
| `SUMMARY` | module name |
| `SOURCE_URL` | the real source repository |
| `SCOPE` | the packages the module hooks |

These entries never need verification — they're the official baseline. Where search also finds the module's real source repo, the two are merged (real stats + official metadata).

Every module also gets its **latest release** fetched (version tag, publish date and a direct APK download link when available) and its **last commit** time is shown. Release data is cached and re-fetched after 7 days, so the daily workflow only pays for a small refresh instead of 1,000+ API calls every run.

### 2. GitHub search, verified by code markers
The same script searches GitHub for modules that are *not* in the official repository. To keep out random repos (Frida toolkits, root-detection collections, tutorials, …), every candidate must contain one of the marker files that Xposed/LSPosed actually require in source code:

- `xposed_init` — the classic Xposed entry point
- `module.prop` — LSPosed module properties
- `module.json` — LSPosed module repo format

Markers are checked at the common source paths (`app/src/main/assets/...`, etc.) via `raw.githubusercontent.com`, which does **not** count against API rate limits. In GitHub Actions (which has a token), candidates that miss every common path also get a full git-tree scan, catching modules with unusual directory layouts.

Candidates that fail verification go into `data/ignored.json` so they aren't re-checked every run (re-checked after 30 days). Verified repos are never duplicated — each run only appends new ones, each tagged with `added_at`.

[`scripts/build-site.js`](scripts/build-site.js) turns the list into a self-contained [`site/index.html`](site/index.html) with search, sorting, language/star/version badges, and "Official" markers for the LSPosed-repo entries.

## One-time setup

1. Create a new repository on GitHub and push this folder to it.
2. In the repository: **Settings → Pages → Build and deployment → Source → `GitHub Actions`** (required for the deploy step).
3. Optional: run the workflow immediately — **Actions → "Update Xposed Modules List" → *Run workflow***.

Your site will be live at `https://<your-username>.github.io/<repo-name>/` and will pick up new modules automatically every day (03:00 UTC).

> Note: GitHub Pages on a **private** repository requires a paid plan — use a public repo for free hosting.

## Running locally

```bash
export GITHUB_TOKEN=ghp_...   # optional but recommended: higher rate limits + git-tree verification
node scripts/find-repos.js    # crawls official repo + searches & verifies candidates
node scripts/build-site.js
# then open site/index.html
```

Without a token the search API allows 10 requests/minute and tree-scan verification is skipped (common marker paths are still checked), so a local run may miss a few modules that the GitHub Actions run finds.

## Customizing

| What | Where |
| --- | --- |
| Search queries | `DEFAULT_QUERIES` in `scripts/find-repos.js` (GitHub search syntax) |
| How deep to search | `--max-pages N` (default 5 pages × 100 results per query; the API caps at 1000 per query) |
| Skip the official-repo crawl | `--no-org` |
| How often rejected candidates are re-checked | `--ignore-ttl-days N` (default 30) |
| How often latest-release info is refreshed | `--release-ttl-days N` (default 7) |
| Update schedule | the `cron` line in `.github/workflows/update.yml` (e.g. `0 6 * * *` = 06:00 UTC) |

## Notes

- The commit pushed by the workflow uses the `github-actions[bot]` identity and does **not** re-trigger this workflow, so there's no loop.
- `data/ignored.json` is committed so the GitHub Actions cache of rejected repos persists across runs.
