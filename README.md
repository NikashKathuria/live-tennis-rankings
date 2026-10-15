# Live Rankings (ATP & WTA singles)

> **Before you host this anywhere else:** the weekly rankings archive only grows while `server.py` is
> running. On any other host, run `python3 rankings_store.py latest` on a schedule (daily is plenty) and
> send `Cache-Control: no-cache` for the HTML and JS. Without that, player-page history stops updating
> and returning visitors can be served stale pages.

Run it:

    python3 server.py 8123      # then open http://localhost:8123

Files

- `index.html` – the page (list view and player pages, both tours)
- `engine.js` – live-points maths and data loading (ESPN feeds, Wikipedia calendar for tournament levels)
- `server.py` – static server with `Cache-Control: no-cache`, plus `/api/history` and `/api/archive`
- `rankings_store.py` – weekly official-rankings archive in `data/rankings/{atp|wta}/{year}-w{week}.json`
  (top 150, back to 2019). `server.py` keeps it current in a background thread: it backfills missing
  weeks at start-up and re-checks for the newest week every 6 hours. Run `python3 rankings_store.py backfill`
  or `latest` by hand if you want to.

Data sources: ESPN's unofficial public tennis feeds (rankings, draws, scores) and Wikipedia's season
calendars (CC BY-SA) for tournament categories. Not affiliated with the ATP or WTA.

Dates and weeks: each archive file is stored under the Monday its ranking took effect (ESPN's "week N" is
the Nth Monday of the year). Neither tour publishes during two-week events, so `/api/history` reports
`n`, the number of calendar weeks each stored ranking was in force, and the page sums `n` for "weeks at #1"
and "weeks in the top 10". `python3 rankings_store.py migrate` adds the date to older files.

## Putting it online (free)

The page itself is static: the browser fetches ESPN and Wikipedia directly, so any static host works.
Only the ranking history needs files, and those are prebuilt:

1. Push this folder to a GitHub repository.
2. Repo Settings -> Pages -> "Deploy from a branch" -> `main` / `(root)`.
3. `.github/workflows/update-rankings.yml` runs daily: it extends the weekly archive, rebuilds
   `data/history/` (`build_static.py`) and commits, which republishes the site.

On GitHub Pages the HTML is cached for about 10 minutes (the host controls that header), so a fresh
deploy can take a few minutes to show up for returning visitors.
