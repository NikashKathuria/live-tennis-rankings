"""Bundle player details so the page doesn't make ~300 ESPN requests on first load.

  python3 build_athletes.py

Writes data/athletes.json for everyone in the newest top-150 rankings:
  {athleteId: {"n": name, "c": country, "f": flag code, "h": hand, "b": birth date,
               "ht": height in inches, "p": birthplace, "d": debut year, "t": fetched (epoch days)}}
Age is deliberately NOT stored: the page works it out from the birth date each time it loads.
Only players missing from the file (or fetched more than 120 days ago) cost a request, so the
scheduled job stays cheap. The page falls back to ESPN for any player not in the file yet.
"""
import concurrent.futures as cf
import json
import os
import re
import time
import urllib.request

import rankings_store as store

OUT = os.path.join(store.ROOT, "data", "athletes.json")
REFRESH_DAYS = 120


def get(url):
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 live-rankings-athletes"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            pass
    return None


def fetch(aid):
    a = get(f"https://sports.core.api.espn.com/v2/sports/tennis/athletes/{aid}?lang=en&region=us")
    if not a:
        return aid, None
    flag = a.get("flag") or {}
    m = re.search(r"/countries/\d+/([a-z]+)\.png", flag.get("href", ""))
    bp = a.get("birthPlace") or {}
    return aid, {
        "n": a.get("displayName") or a.get("fullName"),
        "c": flag.get("alt", ""),
        "f": m.group(1) if m else "",
        "h": (a.get("hand") or {}).get("displayValue", ""),
        "b": (a.get("dateOfBirth") or "")[:10],
        "ht": a.get("height"),
        "p": ", ".join(x for x in [bp.get("city"), bp.get("country")] if x),
        "d": a.get("debutYear"),
        "t": int(time.time() // 86400),
    }


def newest_ids():
    ids = set()
    for tour in store.LEAGUE:
        by_player, dates = store._load(tour)
        ids |= {pid for pid, rows in by_player.items() if dates and rows[-1]["i"] == len(dates) - 1}
    return ids


def main():
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    today = int(time.time() // 86400)
    todo = sorted(i for i in newest_ids() if i not in data or today - data[i].get("t", 0) > REFRESH_DAYS)
    if todo:
        with cf.ThreadPoolExecutor(10) as ex:
            for aid, rec in ex.map(fetch, todo):
                if rec and rec["n"]:
                    data[aid] = rec
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w") as f:
            json.dump(data, f, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    print(f"[athletes] {len(todo)} fetched, {len(data)} players in data/athletes.json")


if __name__ == "__main__":
    main()
