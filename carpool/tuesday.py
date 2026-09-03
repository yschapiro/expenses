#!/usr/bin/env python3
"""Two linked Tuesday carpools, rendered as separate one-page sheets.

Carpool 1 - Schapiro and Brown only. They alternate sessions; whoever is up
that week drives both ways.

Carpool 2 - Schapiro, Brown, Schreiber, Shaiman, Tzur and Natanelli. Schapiro
and Brown only ever take the DROP-OFF leg, and they take it on the same day
they have Carpool 1 - they are making that drive anyway, so they carry the
group. The other four families rotate the PICKUP leg.

Schapiro takes the smaller share of the 17 sessions (8 to Brown's 9), so the
alternation starts on Brown.

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
PICKUPS = ["Schreiber", "Shaiman", "Tzur", "Natanelli"]

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

  .tally{display:flex;flex-wrap:wrap;gap:8px}
  .chip{
    border:1px solid var(--line);border-radius:6px;
    padding:7px 11px 8px;display:flex;flex-direction:column;gap:1px;
    min-width:112px;
  }
  .chip .cw{
    font-family:"Archivo",system-ui,sans-serif;
    font-weight:600;font-size:.97rem;
  }
  .chip .cn{
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums;
  }
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


def build():
    days = [date(y, m, dd) for y, m, ds in DATES for dd in ds]
    days.sort()

    lead = [PAIR[i % 2] for i in range(len(days))]            # carpool 1 + drop-off
    pickup = [PICKUPS[i % len(PICKUPS)] for i in range(len(days))]
    return days, lead, pickup


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


def sheet_two(days, lead, pickup):
    """Carpool 2 - goes to Schreiber, Shaiman, Tzur and Natanelli."""
    families = PAIR[::-1] + PICKUPS
    drop_n = {p: lead.count(p) for p in PAIR}
    pick_n = {p: pickup.count(p) for p in PICKUPS}

    rows = "\n".join(
        f'      <tr class="p{PAIR.index(w)}"><td class="n">{i}</td>'
        f'<td class="date">{fmt(d)}</td>'
        f'<td class="who lead">{html.escape(w)}</td>'
        f'<td class="who">{html.escape(p)}</td></tr>'
        for i, (d, w, p) in enumerate(zip(days, lead, pickup), 1)
    )
    chips = "\n".join(
        f'      <div class="chip"><span class="cw">{p}</span>'
        f'<span class="cn">{pick_n[p]} pickups</span></div>'
        for p in PICKUPS
    )
    return f"""{HEAD.format(title="Tuesday Carpool", css=CSS)}
<div class="wrap">
  <header>
    <p class="eyebrow">Tuesdays &middot; {fmt(days[0])} &ndash; {fmt(days[-1])}</p>
    <h1>Tuesday Carpool</h1>
    <p class="lede">Six families, two drivers a Tuesday. Schapiro and Brown are
      already making the morning run, so they alternate and cover <b>every
      drop-off</b>. Schreiber, Shaiman, Tzur and Natanelli rotate the
      <b>pickups</b>.</p>
    <div class="meta">
      <span><b>{len(days)}</b> Tuesdays</span>
      <span><b>{len(families)}</b> families</span>
      <span>Drop-offs: Schapiro {drop_n['Schapiro']}, Brown {drop_n['Brown']}</span>
      <span>Pickups: 4&ndash;5 each</span>
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
    <h2>Pickups each</h2>
    <div class="tally">
{chips}
    </div>
  </section>

  <footer>
    <p><strong>How the rotation runs.</strong> Drop-offs alternate between Schapiro
      and Brown straight down the list. Pickups cycle through the other four in order,
      coming back around every four Tuesdays &mdash; seventeen doesn&rsquo;t divide by
      four, so Schreiber takes the one extra as first in the cycle.</p>
    <p><strong>Swapping.</strong> Trade directly with the other family and let
      everyone know &mdash; the printed order stays as is.</p>
  </footer>
</div>
"""


def main():
    days, lead, pickup = build()

    (OUT / "tuesday-carpool-1.html").write_text(sheet_one(days, lead))
    (OUT / "tuesday-carpool-2.html").write_text(sheet_two(days, lead, pickup))

    print(f"{len(days)} Tuesdays: {fmt(days[0])} - {fmt(days[-1])}\n")
    print(f"{'Date':<15}{'Carpool 1':<12}{'C2 there':<12}{'C2 back'}")
    for d, w, p in zip(days, lead, pickup):
        print(f"{fmt(d):<15}{w:<12}{w:<12}{p}")
    print()
    for p in PAIR:
        print(f"  {p:<11} {lead.count(p)} Tuesdays (carpool 1 + every drop-off)")
    for p in PICKUPS:
        print(f"  {p:<11} {pickup.count(p)} pickups")


if __name__ == "__main__":
    main()
