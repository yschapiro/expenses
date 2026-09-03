#!/usr/bin/env python3
"""Two linked Tuesday carpools, rendered as separate one-page sheets.

Carpool 1 - Schapiro and Brown only. They alternate sessions; whoever is up
that week drives both ways.

Carpool 2 - Schapiro, Brown, Schreiber, Shaiman, Tzur and Natanelli. It is
its own carpool and every family carries the same share of it: 34 legs over
six families is 5.67, so four take 6 and two take 5.

Schapiro and Brown only ever take the DROP-OFF leg, and only on a day they
already hold Carpool 1 - they are making that drive anyway. That runs one way
only: holding Carpool 1 does not oblige them to take the group. Six dates are
spread through the season where one of the other four takes the drop-off
instead, which is what brings the pair down to an even share.

Schapiro takes the smaller share of both carpools - 8 of the 17 Carpool 1
Tuesdays to Brown's 9, and 5 of the 34 Carpool 2 legs.

The two sheets go to different people, so each is written and rendered on its
own and neither describes the other's internals.

Run:  python3 carpool/tuesday.py   ->  writes the two HTML files
"""

import html
from datetime import date
from pathlib import Path

# --- Configuration -----------------------------------------------------

DATES = [
    (2026, 9, [8, 15, 22]),
    (2026, 10, [6, 13, 20, 27]),
    (2026, 11, [3, 10, 17, 24]),
    (2026, 12, [1, 15, 22, 29]),
    (2027, 1, [5, 12]),
]

PAIR = ["Brown", "Schapiro"]        # order sets who carries the odd session
OTHERS = ["Schreiber", "Shaiman", "Tzur", "Natanelli"]

# Pickups cycle in this order. Starting on Tzur is what lands the one extra
# pickup there rather than on a family that already has two drop-offs.
BACK_ORDER = ["Tzur", "Natanelli", "Schreiber", "Shaiman"]

OUT = Path(__file__).parent

# -----------------------------------------------------------------------

CSS = """
  @page{ size:Letter; margin:14mm 14mm 12mm; }
  :root{
    --ink:#111820; --ink-2:#4A5560; --ink-3:#78838E;
    --line:#D5DDE4; --line-strong:#B0BBC5;
    --a:#0F5570; --a-soft:#E4F0F5;
    --b:#6E4E24; --b-soft:#F4ECDF;
  }
  *{box-sizing:border-box}
  body{
    background:#FFFFFF; color:var(--ink);
    font-family:"Newsreader",Georgia,"Times New Roman",serif;
    font-size:10.2pt; line-height:1.5; margin:0;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{display:flex;flex-direction:column;gap:15px}

  .eyebrow{
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:10.5px;letter-spacing:.17em;text-transform:uppercase;
    color:var(--a);margin:0 0 6px;
  }
  h1{
    font-family:"Archivo",system-ui,sans-serif;
    font-weight:700;font-size:1.9rem;line-height:1.02;
    letter-spacing:-.022em;margin:0 0 8px;text-wrap:balance;
  }
  .lede{margin:0;max-width:66ch;color:var(--ink-2);font-size:1rem}
  .lede b{color:var(--ink);font-weight:400;font-style:italic}
  .meta{
    display:flex;flex-wrap:wrap;gap:6px 16px;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:11.5px;color:var(--ink-2);font-variant-numeric:tabular-nums;
    margin-top:9px;padding-top:8px;border-top:1px solid var(--line);
  }
  .meta b{color:var(--ink);font-weight:500}

  h2{
    font-family:"Archivo",system-ui,sans-serif;
    font-weight:600;font-size:.98rem;margin:0 0 10px;
  }

  table{width:100%;border-collapse:collapse}
  thead th{
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;
    color:var(--ink-3);font-weight:400;text-align:left;
    padding:0 10px 7px;border-bottom:1px solid var(--line-strong);
  }
  tbody td{
    padding:4px 10px;border-bottom:1px solid var(--line);
    vertical-align:middle;
  }
  tbody tr:last-child td{border-bottom:none}
  td.n{
    width:30px;text-align:right;color:var(--ink-3);
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:10.5px;font-variant-numeric:tabular-nums;
  }
  td.date{
    width:118px;white-space:nowrap;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:12.5px;font-variant-numeric:tabular-nums;
  }
  td.who{
    font-family:"Archivo",system-ui,sans-serif;
    font-weight:600;font-size:1.02rem;letter-spacing:-.008em;
  }
  /* the alternating half of the pair, marked so the pattern reads at a glance */
  tr.p0 td.date{box-shadow:inset 3px 0 0 var(--b)}
  tr.p1 td.date{box-shadow:inset 3px 0 0 var(--a)}
  tr.p0 td.lead{color:var(--b)}
  tr.p1 td.lead{color:var(--a)}
  /* sheet 2 marks the pair on the cell - only they appear in the there column */
  td.lead.p0{color:var(--b)}
  td.lead.p1{color:var(--a)}

  .tally{display:flex;flex-wrap:wrap;gap:8px}
  .tally.six{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}
  .chip{
    border:1px solid var(--line);border-radius:6px;
    padding:7px 11px 8px;display:flex;flex-direction:column;gap:1px;
    min-width:0;
  }
  .chip .cw{
    font-family:"Archivo",system-ui,sans-serif;
    font-weight:600;font-size:.97rem;
  }
  .chip .cn{
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums;
  }
  .chip .cn b{color:var(--ink);font-weight:500}
  h2 b{font-weight:600}
  .chip.k0{border-color:var(--b);background:var(--b-soft)}
  .chip.k1{border-color:var(--a);background:var(--a-soft)}

  footer{
    border-top:1px solid var(--line);padding-top:11px;
    color:var(--ink-2);font-size:.92rem;
  }
  footer p{margin:0 0 5px;max-width:70ch}
  footer p:last-child{margin-bottom:0}
  footer strong{
    color:var(--ink);font-weight:400;
    font-family:"Archivo",system-ui,sans-serif;font-size:.89rem;
  }
  tr,section,.chip{break-inside:avoid}
"""

HEAD = """<title>{title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Newsreader:opsz,wght@6..72,400&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>{css}</style>
"""


def fmt(d):
    return f"{d:%b} {d.day}, {d.year}"


def spread(n, m):
    """m indices spread evenly across range(n)."""
    return [round((k + 0.5) * n / m) for k in range(m)]


def build():
    days = [date(y, m, dd) for y, m, ds in DATES for dd in ds]
    days.sort()
    n = len(days)

    # Carpool 1: the pair alternates straight down the list.
    lead = [PAIR[i % 2] for i in range(n)]

    # Carpool 2 drop-offs. The pair takes them on their own Carpool 1 days,
    # except on the handful of dates handed to the other four - without those
    # the pair would carry all 17 and everyone's share would be lopsided.
    handover = spread(n, 6)
    there = list(lead)
    for k, i in enumerate(handover):
        there[i] = OTHERS[k % len(OTHERS)]

    # Carpool 2 pickups: only the other four, cycling.
    back = [BACK_ORDER[i % len(BACK_ORDER)] for i in range(n)]

    families = PAIR + OTHERS
    legs = {f: [there.count(f), back.count(f)] for f in families}

    # The rules this schedule has to satisfy, checked rather than assumed.
    assert all(t != b for t, b in zip(there, back)), "same family both legs"
    assert not any(p in back for p in PAIR), "pair must never take a pickup"
    for p in PAIR:
        assert all(lead[i] == p for i, w in enumerate(there) if w == p), \
            f"{p} drops off on a day they do not hold carpool 1"
    tot = {f: sum(v) for f, v in legs.items()}
    assert max(tot.values()) - min(tot.values()) <= 1, f"uneven: {tot}"
    assert tot["Schapiro"] == min(tot.values()), f"Schapiro not lowest: {tot}"

    return days, lead, there, back, legs


def sheet_one(days, lead):
    """Carpool 1 - goes to Brown."""
    n = {p: lead.count(p) for p in PAIR}
    rows = "\n".join(
        f'      <tr class="p{PAIR.index(w)}"><td class="n">{i}</td>'
        f'<td class="date">{fmt(d)}</td>'
        f'<td class="who lead">{html.escape(w)}</td></tr>'
        for i, (d, w) in enumerate(zip(days, lead), 1)
    )
    chips = "\n".join(
        f'      <div class="chip k{PAIR.index(p)}"><span class="cw">{p}</span>'
        f'<span class="cn">{n[p]} of {len(days)} Tuesdays</span></div>'
        for p in PAIR
    )
    return f"""{HEAD.format(title="Tuesday Carpool &mdash; Schapiro &amp; Brown", css=CSS)}
<div class="wrap">
  <header>
    <p class="eyebrow">Tuesdays &middot; {fmt(days[0])} &ndash; {fmt(days[-1])}</p>
    <h1>Carpool &mdash; Schapiro &amp; Brown</h1>
    <p class="lede">Just the two of us. We alternate week to week, and whoever is
      up that Tuesday drives <b>both ways</b> &mdash; there in the morning and back
      afterwards. No splitting the day.</p>
    <div class="meta">
      <span><b>{len(days)}</b> Tuesdays</span>
      <span>Brown <b>{n['Brown']}</b></span>
      <span>Schapiro <b>{n['Schapiro']}</b></span>
      <span>Alternating, Brown first</span>
    </div>
  </header>

  <section>
    <table>
      <thead><tr><th></th><th>Date</th><th>Driving &mdash; both ways</th></tr></thead>
      <tbody>
{rows}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Tuesdays each</h2>
    <div class="tally">
{chips}
    </div>
  </section>

  <footer>
    <p><strong>Why the counts differ.</strong> Seventeen Tuesdays doesn&rsquo;t split
      in two, so one of us takes the extra. Brown starts, which puts the ninth on
      Brown and the eighth on Schapiro.</p>
    <p><strong>Swapping.</strong> Trade a date between the two of you whenever it
      helps; the printed order doesn&rsquo;t need to change.</p>
  </footer>
</div>
"""


def sheet_two(days, there, back, legs):
    """Carpool 2 - goes to Schreiber, Shaiman, Tzur and Natanelli."""
    families = PAIR[::-1] + OTHERS

    def cell(name):
        cls = f"who lead p{PAIR.index(name)}" if name in PAIR else "who"
        return f'<td class="{cls}">{html.escape(name)}</td>'

    rows = "\n".join(
        f'      <tr><td class="n">{i}</td><td class="date">{fmt(d)}</td>'
        f'{cell(t)}{cell(b)}</tr>'
        for i, (d, t, b) in enumerate(zip(days, there, back), 1)
    )
    chips = "\n".join(
        f'      <div class="chip"><span class="cw">{f}</span>'
        f'<span class="cn">{legs[f][0]} &middot; {legs[f][1]} &middot; '
        f'<b>{sum(legs[f])}</b></span></div>'
        for f in families
    )
    return f"""{HEAD.format(title="Tuesday Carpool", css=CSS)}
<div class="wrap">
  <header>
    <p class="eyebrow">Tuesdays &middot; {fmt(days[0])} &ndash; {fmt(days[-1])}</p>
    <h1>Tuesday Carpool</h1>
    <p class="lede">Six families, two drivers a Tuesday &mdash; one takes them
      <b>there</b>, someone else brings them <b>back</b>. Everyone carries the same
      share. Schapiro and Brown do <b>drop-offs only</b>; the other four take both
      legs.</p>
    <div class="meta">
      <span><b>{len(days)}</b> Tuesdays</span>
      <span><b>{len(families)}</b> families</span>
      <span><b>{len(days) * 2}</b> legs</span>
      <span><b>5&ndash;6</b> legs each</span>
    </div>
  </header>

  <section>
    <table>
      <thead><tr><th></th><th>Date</th><th>Drive there</th><th>Drive back</th></tr></thead>
      <tbody>
{rows}
      </tbody>
    </table>
  </section>

  <section>
    <h2>Legs each &mdash; there &middot; back &middot; <b>total</b></h2>
    <div class="tally six">
{chips}
    </div>
  </section>

  <footer>
    <p><strong>Even shares.</strong> Thirty-four legs across six families is 5.67
      each, so four take six and two take five. Nobody drives both legs of the
      same day.</p>
    <p><strong>Swapping.</strong> Trade directly with the other family and let
      everyone know &mdash; the printed order stays as is.</p>
  </footer>
</div>
"""


def main():
    days, lead, there, back, legs = build()

    (OUT / "tuesday-carpool-1.html").write_text(sheet_one(days, lead))
    (OUT / "tuesday-carpool-2.html").write_text(sheet_two(days, there, back, legs))

    print(f"{len(days)} Tuesdays: {fmt(days[0])} - {fmt(days[-1])}\n")
    print(f"{'Date':<15}{'Carpool 1':<11}{'C2 there':<11}{'C2 back':<11}")
    for d, w, t, b in zip(days, lead, there, back):
        mark = "" if t == w else "   <- pair sits out the drop-off"
        print(f"{fmt(d):<15}{w:<11}{t:<11}{b:<11}{mark}")
    print("\nCarpool 1")
    for p in PAIR:
        print(f"  {p:<11} {lead.count(p)} of {len(days)} Tuesdays")
    print("\nCarpool 2")
    for f in PAIR + OTHERS:
        t, b = legs[f]
        print(f"  {f:<11} {t} there + {b} back = {t + b} legs")


if __name__ == "__main__":
    main()
