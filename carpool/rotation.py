#!/usr/bin/env python3
"""Carpool rotation generator for Spring Gymnastics team sessions.

Team sessions are every Sunday and Wednesday. Fill in CLOSED_DATES from the
gym's published calendar, then run:  python3 carpool/rotation.py

Output is a markdown schedule listing every session date (open and closed),
the assigned driver for each open date, and a per-driver tally.
"""

from datetime import date, timedelta

# --- Configuration -----------------------------------------------------

SEASON_START = date(2026, 9, 6)    # first Sunday of the season
SEASON_END   = date(2027, 6, 30)   # last day to schedule

SESSION_WEEKDAYS = {6: "Sunday", 2: "Wednesday"}  # Python: Mon=0 .. Sun=6

DRIVERS = ["Schapiro", "Kuritsky", "Laufer", "Berkowitz", "Bonan"]

# Dates the gym is CLOSED (no team session). Copy these from the gym's
# calendar as "YYYY-MM-DD": "reason". Only dates that fall on a Sunday or
# Wednesday matter; anything else is ignored with a warning.
CLOSED_DATES = {
    # "2026-11-26": "Thanksgiving",
}

# -----------------------------------------------------------------------


def session_dates():
    d, out = SEASON_START, []
    while d <= SEASON_END:
        if d.weekday() in SESSION_WEEKDAYS:
            out.append(d)
        d += timedelta(days=1)
    return out


def main():
    closed = {date.fromisoformat(k): v for k, v in CLOSED_DATES.items()}
    dates = session_dates()

    stray = sorted(set(closed) - set(dates))
    for s in stray:
        print(f"WARNING: closed date {s} is not a Sunday/Wednesday in the "
              f"season range - ignored.\n")

    rows, turn, tally = [], 0, {n: 0 for n in DRIVERS}
    for d in dates:
        day = SESSION_WEEKDAYS[d.weekday()]
        if d in closed:
            rows.append((d, day, "CLOSED", closed[d]))
        else:
            driver = DRIVERS[turn % len(DRIVERS)]
            turn += 1
            tally[driver] += 1
            rows.append((d, day, "Open", driver))

    n_open = sum(tally.values())
    print(f"# Carpool Rotation - Spring Gymnastics Team Sessions")
    print(f"\n**Season:** {SEASON_START:%b %-d, %Y} - {SEASON_END:%b %-d, %Y}"
          f"  |  **Sessions:** Sundays & Wednesdays")
    print(f"**{n_open} open sessions**, {len(dates) - n_open} closed, "
          f"{len(DRIVERS)} drivers\n")

    print("| # | Date | Day | Status | Driver / Reason |")
    print("|---|------|-----|--------|-----------------|")
    num = 0
    for d, day, status, who in rows:
        if status == "Open":
            num += 1
            print(f"| {num} | {d:%b %-d, %Y} | {day} | Open | **{who}** |")
        else:
            print(f"|  | {d:%b %-d, %Y} | {day} | *CLOSED* | _{who}_ |")

    print("\n## Closed dates\n")
    if closed:
        for d in sorted(closed):
            if d in dates:
                print(f"- **{d:%a, %b %-d, %Y}** - {closed[d]}")
    else:
        print("_None entered yet - fill in CLOSED_DATES._")

    print("\n## Drives per person\n")
    print("| Driver | Drives |")
    print("|--------|--------|")
    for name in DRIVERS:
        print(f"| {name} | {tally[name]} |")
    lo, hi = min(tally.values()), max(tally.values())
    print(f"\nSpread: {lo}-{hi} drives "
          f"({'perfectly even' if lo == hi else 'even within 1 turn'}).")


if __name__ == "__main__":
    main()
