# Xposed Modules Directory

A GitHub Actions–powered static website that keeps a searchable list of Xposed module repositories found on GitHub.

## How it works

1. **[`scripts/find-repos.js`](scripts/find-repos.js)** queries the [GitHub repository search API](https://docs.github.com/en/rest/search/search#search-repositories) for Xposed-related repos — by topic (`topic:xposed-module`, `topic:xposed`) and by name/description.
2. Results are merged into **[`data/repos.json`](data/repos.json)**, deduped by repo name. **Repos already in the list are never added twice** — each new run only appends repos that weren't there before (each new repo gets an `added_at` timestamp).
3. **[`scripts/build-site.js`](scripts/build-site.js)** turns the list into a self-contained **[`site/index.html`](site/index.html)** with search, sorting, and language/star/new badges.
4. The workflow **[`.github/workflows/update.yml`](.github/workflows/update.yml)** runs these steps on a schedule (daily 03:00 UTC), commits the updated data + site, and deploys the site to GitHub Pages.

## One-time setup

1. Create a new repository on GitHub and push this folder to it.
2. In the repository: **Settings → Pages → Build and deployment → Source → `GitHub Actions`** (required for the deploy step).
3. Optional: run the workflow immediately — **Actions → "Update Xposed Modules List" → *Run workflow***.

Your site will be live at `https://<your-username>.github.io/<repo-name>/` and will pick up new modules automatically every day.

> Note: GitHub Pages on a **private** repository requires a paid plan — use a public repo (or enable Pages on your plan) for free hosting.

## Running locally

```bash
node scripts/find-repos.js   # optional: set GITHUB_TOKEN first for higher API rate limits
node scripts/build-site.js
# then open site/index.html
```

## Customizing

| What | Where |
| --- | --- |
| Search queries | `DEFAULT_QUERIES` in `scripts/find-repos.js` (GitHub search syntax) |
| How deep to search | `--max-pages N` (default 5 pages × 100 results per query; the API caps at 1000 per query) |
| Update schedule | the `cron` line in `.github/workflows/update.yml` (e.g. `0 6 * * *` = 06:00 UTC) |
| Which repos are shown | any field filter can be added to `visible()` in `scripts/build-site.js` |

## Notes

- Without a token the search API allows 10 requests/minute; the workflow passes `GITHUB_TOKEN` automatically for 30/minute.
- The commit pushed by the workflow uses the `github-actions[bot]` identity and does **not** re-trigger this workflow, so there's no loop.
