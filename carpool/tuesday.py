#!/usr/bin/env python3
"""Two linked Tuesday carpools, rendered as separate one-page sheets.

Carpool 1 - Schapiro and Brown only. They alternate sessions and whoever is up
drives both ways. Seventeen Tuesdays won't halve, so the opening Tuesday is
split instead - Brown out, Schapiro back - and the remaining sixteen alternate
whole. That lands both families on exactly 17 of the 34 legs.

Carpool 2 - Schapiro, Brown, Schreiber, Shaiman, Tzur and Natanelli. It is its
own carpool and every family carries the same share of it: 34 legs over six
families is 5.67, so four take 6 and two take 5.

Schapiro and Brown only ever take the DROP-OFF leg there, and only on a day
they are already driving out for Carpool 1. That runs one way only: holding
Carpool 1 does not oblige them to take the group. Six dates spread through the
season hand the drop-off to one of the other four instead, which is what brings
the pair down to an even share. Schapiro takes the smaller of the two at 5.

The two sheets go to different people, so each is rendered on its own and
neither describes the other's internals.

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

PAIR = ["Brown", "Schapiro"]        # carpool 1, alternating in this order
OTHERS = ["Schreiber", "Shaiman", "Tzur", "Natanelli"]

# Pickups cycle in this order. Starting on Tzur is what lands the one extra
# pickup there rather than on a family that already has two drop-offs.
BACK_ORDER = ["Tzur", "Natanelli", "Schreiber", "Shaiman"]

# The opening Tuesday is shared rather than driven whole by one family, which
# is what makes carpool 1 come out exactly even over an odd number of sessions.
SPLIT_FIRST = True

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
  h2 b{font-weight:600}

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
  /* the pair are colour-coded so the alternation reads without counting */
  td.p0{color:var(--b)}
  td.p1{color:var(--a)}
  tr.w0 td.date{box-shadow:inset 3px 0 0 var(--b)}
  tr.w1 td.date{box-shadow:inset 3px 0 0 var(--a)}
  /* the one shared Tuesday gets a stripe of both */
  tr.shared td.date{
    background:linear-gradient(to bottom, var(--b) 0 50%, var(--a) 50%)
               left/3px 100% no-repeat;
  }
  td.tag{
    width:52px;text-align:right;white-space:nowrap;
    font-family:"IBM Plex Mono",ui-monospace,monospace;
    font-size:9px;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);
  }

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

    # Carpool 1: (there, back) per Tuesday. The pair alternates whole days,
    # except the opener, which they share so the season halves exactly.
    c1 = [(PAIR[i % 2], PAIR[i % 2]) for i in range(n)]
    if SPLIT_FIRST:
        c1[0] = (PAIR[0], PAIR[1])

    # Carpool 2 drop-offs: whoever is already driving out for carpool 1, minus
    # the dates handed to the other four - without those the pair would carry
    # all 17 and everyone's share would be lopsided.
    handover = spread(n, 6)
    there = [t for t, _ in c1]
    for k, i in enumerate(handover):
        there[i] = OTHERS[k % len(OTHERS)]

    # Carpool 2 pickups: only the other four, cycling.
    back = [BACK_ORDER[i % len(BACK_ORDER)] for i in range(n)]

    c1_legs = {p: sum(leg.count(p) for leg in c1) for p in PAIR}
    c2_legs = {f: [there.count(f), back.count(f)] for f in PAIR + OTHERS}

    # The rules each schedule has to satisfy, checked rather than assumed.
    assert max(c1_legs.values()) - min(c1_legs.values()) == 0, \
        f"carpool 1 not even: {c1_legs}"
    assert all(t != b for t, b in zip(there, back)), "same family both legs"
    assert not any(p in back for p in PAIR), "pair must never take a pickup"
    for i, w in enumerate(there):
        assert w not in PAIR or c1[i][0] == w, \
            f"{w} drops off on {days[i]} without driving out for carpool 1"
    tot = {f: sum(v) for f, v in c2_legs.items()}
    assert max(tot.values()) - min(tot.values()) <= 1, f"carpool 2 uneven: {tot}"
    assert tot["Schapiro"] == min(tot.values()), f"Schapiro not lowest: {tot}"

    return days, c1, there, back, c1_legs, c2_legs


def name_cell(name, extra=""):
    cls = f"who p{PAIR.index(name)}" if name in PAIR else "who"
    return f'<td class="{cls}{extra}">{html.escape(name)}</td>'


def sheet_one(days, c1, legs):
    """Carpool 1 - goes to Brown."""
    rows = []
    for i, (d, (t, b)) in enumerate(zip(days, c1), 1):
        shared = t != b
        cls = "shared" if shared else f"w{PAIR.index(t)}"
        tag = "shared" if shared else ""   # the two columns already say "both ways"
        rows.append(
            f'      <tr class="{cls}"><td class="n">{i}</td>'
            f'<td class="date">{fmt(d)}</td>'
            f'{name_cell(t)}{name_cell(b)}<td class="tag">{tag}</td></tr>'
        )
    full = {p: sum(1 for t, b in c1 if t == b == p) for p in PAIR}
    chips = "\n".join(
        f'      <div class="chip k{PAIR.index(p)}"><span class="cw">{p}</span>'
        f'<span class="cn"><b>{legs[p]}</b> legs &middot; {full[p]} whole Tuesdays'
        f'{" + 1 leg" if legs[p] > full[p] * 2 else ""}</span></div>'
        for p in PAIR
    )
    return f"""{HEAD.format(title="Tuesday Carpool &mdash; Schapiro &amp; Brown", css=CSS)}
<div class="wrap">
  <header>
    <p class="eyebrow">Tuesdays &middot; {fmt(days[0])} &ndash; {fmt(days[-1])}</p>
    <h1>Carpool &mdash; Schapiro &amp; Brown</h1>
    <p class="lede">Just the two of us. We alternate week to week and whoever is up
      drives <b>both ways</b>. The one exception is the opening Tuesday, which we
      <b>split</b> &mdash; Brown out, Schapiro back &mdash; so seventeen Tuesdays come
      out dead even.</p>
    <div class="meta">
      <span><b>{len(days)}</b> Tuesdays</span>
      <span><b>{len(days) * 2}</b> legs</span>
      <span>Brown <b>{legs['Brown']}</b></span>
      <span>Schapiro <b>{legs['Schapiro']}</b></span>
    </div>
  </header>

  <section>
    <table>
      <thead><tr><th></th><th>Date</th><th>Drive there</th><th>Drive back</th><th></th></tr></thead>
      <tbody>
{chr(10).join(rows)}
      </tbody>
    </table>
  </section>

  <section>
    <h2>The split</h2>
    <div class="tally">
{chips}
    </div>
  </section>

  <footer>
    <p><strong>Why the opener is shared.</strong> Seventeen Tuesdays don&rsquo;t
      halve. Splitting the first one and alternating whole days after it leaves us
      on {legs['Brown']} legs each &mdash; exactly even, no odd Tuesday to argue over.</p>
    <p><strong>Swapping.</strong> Trade a date between the two of you whenever it
      helps; the printed order doesn&rsquo;t need to change.</p>
  </footer>
</div>
"""


def sheet_two(days, there, back, legs):
    """Carpool 2 - goes to Schreiber, Shaiman, Tzur and Natanelli."""
    families = PAIR[::-1] + OTHERS
    rows = "\n".join(
        f'      <tr><td class="n">{i}</td><td class="date">{fmt(d)}</td>'
        f'{name_cell(t)}{name_cell(b)}</tr>'
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
    days, c1, there, back, c1_legs, c2_legs = build()

    (OUT / "tuesday-carpool-1.html").write_text(sheet_one(days, c1, c1_legs))
    (OUT / "tuesday-carpool-2.html").write_text(sheet_two(days, there, back, c2_legs))

    print(f"{len(days)} Tuesdays: {fmt(days[0])} - {fmt(days[-1])}\n")
    print(f"{'Date':<15}{'C1 there':<11}{'C1 back':<11}{'C2 there':<11}{'C2 back':<11}")
    for d, (t1, b1), t2, b2 in zip(days, c1, there, back):
        note = "   <- shared" if t1 != b1 else ("   <- pair sits out drop-off"
                                                if t2 != t1 else "")
        print(f"{fmt(d):<15}{t1:<11}{b1:<11}{t2:<11}{b2:<11}{note}")
    print("\nCarpool 1 (34 legs)")
    for p in PAIR:
        print(f"  {p:<11} {c1_legs[p]} legs")
    print("\nCarpool 2 (34 legs)")
    for f in PAIR + OTHERS:
        t, b = c2_legs[f]
        print(f"  {f:<11} {t} there + {b} back = {t + b} legs")


if __name__ == "__main__":
    main()
