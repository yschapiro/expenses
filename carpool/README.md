# Carpool Rotation

Rotation for Spring Gymnastics team sessions (Sundays & Wednesdays).

Each session takes two drivers: one for the ride THERE, one for the ride BACK.

Drivers, in rotation order: Schapiro, Kuritsky, Laufer, Berkowitz, Bonan.

## Adding the gym's closed dates

Open `rotation.py` and fill in `CLOSED_DATES` from the gym's published
calendar:

```python
CLOSED_DATES = {
    "2026-11-25": "Thanksgiving break",
    "2026-12-24": "Winter break",
}
```

Then regenerate the schedule:

```
python3 carpool/rotation.py > carpool/SCHEDULE.md
```

Closed dates are listed in the schedule but do **not** consume a turn — the
rotation simply continues on the next open date, so the drives stay evenly
split (within one turn of each other).

`SEASON_START` / `SEASON_END` at the top of the script set the date range.
