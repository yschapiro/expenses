#!/usr/bin/env python3
"""Carpool rotation for Spring Gymnastics team sessions.

Each session needs two drivers: one for the ride THERE, one for the ride
BACK. Drivers are dealt round-robin across the legs in chronological order
(there, back, there, back, ...), which gives three properties for free:

  * Nobody drives both legs of the same day (5 drivers, 2 legs per session,
    so the pair is always two adjacent names in the cycle).
  * Over every 5 sessions each person drives exactly one there and one back,
    so the there/back split stays even, not just the total.
  * Closed dates and the competition block are listed but consume no turn,
    so removing a date never doubles anyone up.

Run:  python3 carpool/rotation.py > carpool/SCHEDULE.md
"""

from datetime import date, timedelta

# --- Configuration -----------------------------------------------------

DRIVERS = ["Schapiro", "Kuritsky", "Laufer", "Berkowitz", "Bonan"]

SESSION_WEEKDAYS = {6: "Sunday", 2: "Wednesday"}  # Python: Mon=0 .. Sun=6

# Dates the gym is OPEN for team sessions, per the gym's calendar.
OPEN_DATES = [
    "2026-09-06", "2026-09-09", "2026-09-16", "2026-09-23",
    "2026-10-07", "2026-10-11", "2026-10-14", "2026-10-18",
    "2026-10-21", "2026-10-25", "2026-10-28",
    "2026-11-01", "2026-11-04", "2026-11-08", "2026-11-11",
    "2026-11-15", "2026-11-18", "2026-11-22", "2026-11-25", "2026-11-29",
    "2026-12-02", "2026-12-13", "2026-12-16", "2026-12-23",
    "2026-12-27", "2026-12-30",
    "2027-01-03", "2027-01-06", "2027-01-10", "2027-01-13",
    "2027-01-17", "2027-01-24",
    "2027-02-07",
]

# Open dates with no carpool assigned (listed, but skipped in the rotation).
BLOCKED = {
    "2026-12-13": "Potential competition day - no carpool",
}

# Open gym trips. Dates not set yet; drivers are locked in now so the
# rotation stays even once dates are filled in.
OPEN_GYM_COUNT = 4

# -----------------------------------------------------------------------


def closed_dates(opened):
    """Every Sunday/Wednesday in the season span that is not an open date."""
    out, d = [], min(opened)
    while d <= max(opened):
        if d.weekday() in SESSION_WEEKDAYS and d not in opened:
            out.append(d)
        d += timedelta(days=1)
    return out


def main():
    opened = sorted(date.fromisoformat(s) for s in OPEN_DATES)
    blocked = {date.fromisoformat(k): v for k, v in BLOCKED.items()}
    closed = closed_dates(set(opened))

    # Sessions needing drivers, in the order the rotation deals them.
    sessions = [d for d in opened if d not in blocked]
    sessions += [None] * OPEN_GYM_COUNT           # open gym, dates TBD

    there = {n: 0 for n in DRIVERS}
    back = {n: 0 for n in DRIVERS}
    plan = []
    for k, d in enumerate(sessions):
        a = DRIVERS[(2 * k) % len(DRIVERS)]
        b = DRIVERS[(2 * k + 1) % len(DRIVERS)]
        there[a] += 1
        back[b] += 1
        plan.append((d, a, b))

    dated = [p for p in plan if p[0] is not None]
    gym = [p for p in plan if p[0] is None]
    by_date = {p[0]: p for p in dated}

    print("# Carpool Rotation - Spring Gymnastics Team Sessions\n")
    print(f"**Season:** {opened[0]:%b %-d, %Y} - {opened[-1]:%b %-d, %Y}  |  "
          f"**Sessions:** Sundays & Wednesdays  |  **Drivers:** "
          f"{len(DRIVERS)}\n")
    print(f"{len(dated)} team carpools + {len(gym)} open gym = "
          f"{len(plan)} round trips, {2 * len(plan)} legs. "
          f"{len(closed)} closed dates, {len(blocked)} blocked.\n")
    print("Each session has two drivers: **THERE** (drop-off) and "
          "**BACK** (pickup). Nobody drives both legs of the same day.\n")

    # --- schedule ---
    print("## Team sessions\n")
    print("| # | Date | Day | Status | Drive there | Drive back |")
    print("|---|------|-----|--------|-------------|------------|")
    num = 0
    for d in opened:
        day = SESSION_WEEKDAYS[d.weekday()]
        if d in blocked:
            print(f"|  | {d:%b %-d, %Y} | {day} | *BLOCKED* | "
                  f"- | _{blocked[d]}_ |")
        else:
            num += 1
            _, a, b = by_date[d]
            print(f"| {num} | {d:%b %-d, %Y} | {day} | Open | "
                  f"**{a}** | **{b}** |")

    print("\n## Open gym\n")
    print("Dates to be filled in; drivers are already assigned so the "
          "totals stay even.\n")
    print("| # | Date | Drive there | Drive back |")
    print("|---|------|-------------|------------|")
    for i, (_, a, b) in enumerate(gym, 1):
        print(f"| OG{i} | _TBD_ | **{a}** | **{b}** |")

    print("\n## Closed dates (no session)\n")
    for d in closed:
        print(f"- **{d:%a, %b %-d, %Y}** - gym closed")
    for d in sorted(blocked):
        print(f"- **{d:%a, %b %-d, %Y}** - {blocked[d]}")

    print("\n## Drives per person\n")
    print("| Driver | There | Back | Total |")
    print("|--------|-------|------|-------|")
    for n in DRIVERS:
        print(f"| {n} | {there[n]} | {back[n]} | {there[n] + back[n]} |")
    tot = [there[n] + back[n] for n in DRIVERS]
    print(f"\nSpread: {min(tot)}-{max(tot)} legs "
          f"({'perfectly even' if min(tot) == max(tot) else 'even within 1 leg'}).")


if __name__ == "__main__":
    main()
