"""Self-host small flag images so the page doesn't pull 500x500 PNGs from ESPN.

  python3 build_flags.py      # needs Pillow:  pip install pillow

Run build_athletes.py first: the country codes come from data/athletes.json. Any flag not yet
in flags/ is downloaded, trimmed the transparent padding and shrinks it to 44px wide (~1 KB each).
The page uses flags/<code>.png and falls back to ESPN's image if a file is missing.
Russia and Belarus are skipped on purpose: the site doesn't show those flags.
"""
import io
import json
import os
import urllib.request

from PIL import Image

import rankings_store as store

ROOT = store.ROOT
FLAGS = os.path.join(ROOT, "flags")
ATHLETES = os.path.join(ROOT, "data", "athletes.json")  # written by build_athletes.py
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
    athletes = json.load(open(ATHLETES)) if os.path.exists(ATHLETES) else {}
    codes = {a["f"] for a in athletes.values() if a.get("f") and a["f"] not in SKIP}
    missing = sorted(c for c in codes if not os.path.exists(os.path.join(FLAGS, f"{c}.png")))
    made = sum(make_flag(c) for c in missing)
    print(f"[flags] {made}/{len(missing)} new flag images, {len(codes)} countries total")


if __name__ == "__main__":
    main()
