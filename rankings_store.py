"""Weekly official-rankings archive.

ESPN's public feed keeps weekly ATP/WTA rankings (top 150) back to about 2019.
This module copies them into data/rankings/{atp|wta}/{year}-w{week}.json so player
pages can show history, and keeps the archive current going forward.

  python3 rankings_store.py backfill   # fetch every missing week since 2019
  python3 rankings_store.py latest     # fetch the newest published week
  python3 rankings_store.py status

Each file: {"tour","year","week","date","updated","ranks":[[athleteId, rank, points], ...]}

`date` is the Monday the ranking took effect. ESPN numbers its weeks as "the Nth Monday
of the year", so week N falls on first_monday(year) + 7*(N-1). (ESPN's own `lastUpdated`
timestamp is not a ranking date: its weekday drifts from year to year.) Checked against
known dates, e.g. Sinner first No.1 on 2024-06-10 (2024 w24), Alcaraz 2022-09-12 (2022 w37)
and 2025-09-08 (2025 w36), Djokovic 2020-02-03 (2020 w5).

Both tours pause new rankings during two-week events, so some Mondays have no file. A
ranking stays in force until the next one is published, and history() reports how many
calendar weeks each stored ranking was in force, which is how the tours count weeks.
"""
import concurrent.futures as cf
import datetime
import json
import os
import re
import sys
import threading
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data", "rankings")
LEAGUE = {"atp": 1, "wta": 2}
FIRST_YEAR = 2019
CORE = "https://sports.core.api.espn.com/v2/sports/tennis/leagues/{tour}"
_lock = threading.Lock()
_cache = {}


def http_json(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 live-rankings-archive"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
        except Exception:
            pass
    return None


def first_monday(year):
    d = datetime.date(year, 1, 1)
    return d + datetime.timedelta(days=(7 - d.weekday()) % 7)


def effective_date(year, week):
    """The Monday this ranking took effect, as an ISO string."""
    return (first_monday(year) + datetime.timedelta(days=7 * (week - 1))).isoformat()


def file_path(tour, year, week):
    return os.path.join(DATA, tour, f"{year}-w{week:02d}.json")


def fetch_week(tour, year, week):
    url = f"{CORE.format(tour=tour)}/seasons/{year}/types/2/weeks/{week}/rankings/{LEAGUE[tour]}?lang=en&region=us"
    r = http_json(url)
    if not r or not r.get("ranks"):
        return None
    ranks = []
    for x in r["ranks"]:
        m = re.search(r"/athletes/(\d+)", x["athlete"]["$ref"])
        if m:
            ranks.append([int(m.group(1)), x["current"], x["points"]])
    return {"tour": tour, "year": year, "week": week, "date": effective_date(year, week),
            "updated": r.get("lastUpdated"), "ranks": ranks}


def save(snap):
    p = file_path(snap["tour"], snap["year"], snap["week"])
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(snap, f, separators=(",", ":"))
    os.replace(tmp, p)


def fetch_and_save(args):
    tour, year, week = args
    snap = fetch_week(tour, year, week)
    if snap:
        save(snap)
    return bool(snap)


def backfill(workers=8, log=print):
    """Fetch every week that is not yet on disk. Safe to run repeatedly."""
    this_year = datetime.date.today().year
    jobs = [(t, y, w) for t in LEAGUE for y in range(FIRST_YEAR, this_year + 1) for w in range(1, 54)
            if not os.path.exists(file_path(t, y, w))]
    if not jobs:
        return 0
    log(f"[archive] fetching {len(jobs)} week slots (missing weeks simply don't exist upstream)")
    with cf.ThreadPoolExecutor(workers) as ex:
        saved = sum(ex.map(fetch_and_save, jobs))
    log(f"[archive] saved {saved} new weeks")
    return saved


def latest(tour):
    """Newest published week. Re-fetched each time because a week can be revised."""
    idx = http_json(f"{CORE.format(tour=tour)}/rankings")
    if not idx or not idx.get("items"):
        return None
    m = re.search(r"/seasons/(\d+)/types/\d+/weeks/(\d+)/", idx["items"][0]["$ref"])
    if not m:
        return None
    snap = fetch_week(tour, int(m.group(1)), int(m.group(2)))
    if snap:
        save(snap)
    return snap


def sync_forever(every_hours=6, log=print):
    import time
    while True:
        try:
            backfill(log=log)
            migrate(log=log)
            for t in LEAGUE:
                s = latest(t)
                if s:
                    log(f"[archive] {t.upper()} week {s['week']} {s['year']} up to date")
        except Exception as e:  # never let the background thread die
            log(f"[archive] sync error: {e}")
        time.sleep(every_hours * 3600)


def migrate(log=print):
    """Add the effective Monday to archive files written before it existed."""
    n = 0
    for t in LEAGUE:
        d = os.path.join(DATA, t)
        for f in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not f.endswith(".json"):
                continue
            p = os.path.join(d, f)
            with open(p) as fh:
                snap = json.load(fh)
            want = effective_date(snap["year"], snap["week"])
            if snap.get("date") != want:
                snap["date"] = want
                save(snap)
                n += 1
    if n:
        log(f"[archive] added effective dates to {n} files")
    return n


def _load(tour):
    d = os.path.join(DATA, tour)
    if not os.path.isdir(d):
        return {}, []
    files = sorted(f for f in os.listdir(d) if f.endswith(".json"))
    stamp = (len(files), max((os.path.getmtime(os.path.join(d, f)) for f in files), default=0))
    with _lock:
        hit = _cache.get(tour)
        if hit and hit[0] == stamp:
            return hit[1], hit[2]
    snaps = {}
    for f in files:
        try:
            with open(os.path.join(d, f)) as fh:
                s = json.load(fh)
        except Exception:
            continue
        date = s.get("date") or effective_date(s["year"], s["week"])
        snaps[date] = s  # one ranking per Monday; the later file wins if two ever map to the same day
    dates = sorted(snaps)
    by_player = {}
    for i, date in enumerate(dates):
        s = snaps[date]
        for aid, rank, pts in s["ranks"]:
            by_player.setdefault(str(aid), []).append({"i": i, "y": s["year"], "w": s["week"], "d": date, "rank": rank, "pts": pts})
    with _lock:
        _cache[tour] = (stamp, by_player, dates)
    return by_player, dates


def history(tour, athlete_id, today=None):
    """Weekly rankings for one player. `n` = calendar weeks that ranking was in force,
    i.e. the gap to the next published ranking (the newest one runs through the current week)."""
    by_player, dates = _load(tour)
    today = today or datetime.date.today()
    this_monday = today - datetime.timedelta(days=today.weekday())
    out = []
    for r in by_player.get(str(athlete_id), []):
        start = datetime.date.fromisoformat(r["d"])
        if r["i"] + 1 < len(dates):
            end = datetime.date.fromisoformat(dates[r["i"] + 1])
        else:
            end = max(start, this_monday) + datetime.timedelta(days=7)
        out.append({"y": r["y"], "w": r["w"], "d": r["d"], "rank": r["rank"], "pts": r["pts"], "n": max(1, (end - start).days // 7)})
    return out


def status():
    out = {}
    for t in LEAGUE:
        d = os.path.join(DATA, t)
        files = sorted(os.listdir(d)) if os.path.isdir(d) else []
        out[t] = {"weeks": len(files), "first": files[0][:-5] if files else None, "last": files[-1][:-5] if files else None}
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "migrate":
        migrate()
    elif cmd == "backfill":
        backfill()
    elif cmd == "latest":
        for t in LEAGUE:
            print(t, (latest(t) or {}).get("week"))
    print(json.dumps(status()))
