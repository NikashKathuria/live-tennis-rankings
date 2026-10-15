"""Self-host small flag images so the page doesn't pull 500x500 PNGs from ESPN.

  python3 build_flags.py      # needs Pillow:  pip install pillow

For everyone in the newest top-150 rankings it works out their country code (cached in
data/athlete_flags.json, so only new players cost a request), downloads any flag not yet in
flags/, trims the transparent padding and shrinks it to 44px wide (~1 KB each).
The page uses flags/<code>.png and falls back to ESPN's image if a file is missing.
Russia and Belarus are skipped on purpose: the site doesn't show those flags.
"""
import concurrent.futures as cf
import io
import json
import os
import re
import urllib.request

from PIL import Image

import rankings_store as store

ROOT = store.ROOT
FLAGS = os.path.join(ROOT, "flags")
MAP = os.path.join(ROOT, "data", "athlete_flags.json")
SKIP = {"rus", "blr"}
WIDTH = 44


def get(url, binary=False):
    for _ in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 live-rankings-flags"})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            return data if binary else json.loads(data)
        except Exception:
            pass
    return None


def flag_code(athlete_id):
    a = get(f"https://sports.core.api.espn.com/v2/sports/tennis/athletes/{athlete_id}?lang=en&region=us")
    m = re.search(r"/countries/\d+/([a-z]+)\.png", ((a or {}).get("flag") or {}).get("href", ""))
    return athlete_id, (m.group(1) if m else "")


def newest_ids():
    ids = set()
    for tour in store.LEAGUE:
        by_player, dates = store._load(tour)
        ids |= {pid for pid, rows in by_player.items() if dates and rows[-1]["i"] == len(dates) - 1}
    return ids


def make_flag(code):
    raw = get(f"https://a.espncdn.com/i/teamlogos/countries/500/{code}.png", binary=True)
    if not raw:
        return False
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    box = im.getchannel("A").getbbox()
    if box:
        im = im.crop(box)
    im = im.resize((WIDTH, max(1, round(im.height * WIDTH / im.width))), Image.LANCZOS)
    im.save(os.path.join(FLAGS, f"{code}.png"), optimize=True)
    return True


def main():
    os.makedirs(FLAGS, exist_ok=True)
    os.makedirs(os.path.dirname(MAP), exist_ok=True)
    known = json.load(open(MAP)) if os.path.exists(MAP) else {}
    todo = sorted(i for i in newest_ids() if i not in known)
    if todo:
        with cf.ThreadPoolExecutor(10) as ex:
            for aid, code in ex.map(flag_code, todo):
                known[aid] = code
        with open(MAP, "w") as f:
            json.dump(known, f, separators=(",", ":"), sort_keys=True)
    codes = {c for c in known.values() if c and c not in SKIP}
    missing = sorted(c for c in codes if not os.path.exists(os.path.join(FLAGS, f"{c}.png")))
    made = sum(make_flag(c) for c in missing)
    print(f"[flags] {len(todo)} new players looked up, {made}/{len(missing)} new flag images, {len(codes)} countries total")


if __name__ == "__main__":
    main()
