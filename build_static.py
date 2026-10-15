"""Write per-player history files so the site works on plain static hosting (no server.py).

  python3 build_static.py

Produces data/history/{atp|wta}/{athleteId}.json for every player in the newest ranking,
in the same shape as server.py's /api/history. The page tries /api/history first and falls
back to these files, so it works both locally and on GitHub Pages.
"""
import json
import os
import shutil

import rankings_store as store

OUT = os.path.join(store.ROOT, "data", "history")


def main():
    total = 0
    for tour in store.LEAGUE:
        by_player, dates = store._load(tour)
        if not dates:
            continue
        newest = [pid for pid, rows in by_player.items() if rows[-1]["i"] == len(dates) - 1]
        d = os.path.join(OUT, tour)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        for pid in newest:
            with open(os.path.join(d, f"{pid}.json"), "w") as f:
                json.dump({"tour": tour, "id": pid, "weeks": store.history(tour, pid)}, f, separators=(",", ":"))
        total += len(newest)
    print(f"[static] wrote history for {total} players")


if __name__ == "__main__":
    main()
