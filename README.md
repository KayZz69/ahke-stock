# AHKE Stock

Stock tool for the AHKE stationery cupboard. Static files, no dependencies, no build
step. Works offline once loaded and installs to a phone home screen.

**Live:** https://kayzz69.github.io/ahke-stock/ (GitHub Pages, HTTPS)

## Running it

Serve the folder:

```bash
python -m http.server 8765
```

then open `http://localhost:8765`. Opening `index.html` straight from disk also works,
but without offline support (service workers need `http(s)`).

### On your phone

The phone has to reach the files over **HTTPS** — a service worker will not register on
plain `http://` anywhere except `localhost`. Once hosted (e.g. on the Hetzner VPS behind
Caddy or nginx with a Let's Encrypt certificate, serving this folder as-is):

- **Android / Chrome:** open the URL → menu → *Install app* (or *Add to Home screen*)
- **iPhone / Safari:** open the URL → Share → *Add to Home Screen*

After the first visit it opens with no signal. When online it always fetches the latest
version, so updates arrive without reinstalling.

**Data stays on the device it was entered on.** The phone and a laptop browser have
separate data. Use Setup → Export / Import to move it, and export regularly as a backup.

## Files

| File | Purpose |
|---|---|
| `index.html` | the whole app |
| `sw.js` | service worker — network-first, falls back to cache offline |
| `manifest.webmanifest` | home-screen install metadata |
| `icon.svg`, `icon-192.png`, `icon-512.png` | app icons |

## What it does

**Stock** — current quantity and status for all 12 items, the age of the last count, and
buttons to count or prepare an order.

**Count stock** — all 12 items in one mobile-first pass. Previous quantity is shown but
never silently copied; `Same` is an explicit tap. Blank means **unknown**, `0` means **none
left**. Entries must fall on the item's quantity step (Coffee 0.1 kg, everything else whole
units). The draft autosaves and has no effect on live stock until completed; completion is
blocked until all 12 items are entered. A second completed count on the same Asia/Almaty
date asks: deliberate recount, or correction of the earlier one.

**Prepare order** — `REORDER` items selected by default, `LOW` items one tap away.
Suggested quantity brings stock up to target. Supplier and quantity are overridable per
line, and each supplier gets its own independent order. `UNKNOWN` items are excluded and
listed separately. Order lines snapshot item name, unit, thresholds and stock level, so
later edits never rewrite history.

**Orders** — `DRAFT → ORDERED → PARTIALLY RECEIVED → RECEIVED`, plus `CANCELLED` and
`CLOSED SHORT`, always derived from line balances. **Copy list** produces a plain tick-off
list to work down beside the supplier's website (falls back to a copyable dialog where the
clipboard is blocked). Receiving updates stock immediately; partial receipts leave the rest
open; over-receipt is refused. A mistaken receipt is **voided** with a required reason — the
original stays visible and stock is recalculated by replay, never by a negative entry.

**History** — every operation, filterable; superseded counts and voided receipts are struck
through, never removed.

**Setup** — edit thresholds and preferred supplier per item (validated as
`0 ≤ reorder ≤ warn < target`), and export/import the backup. Imports are validated first
and rejected without touching stored data if anything is malformed.

## Master data

Seeded from `AHKE Stationery Stock.xlsx` (26 Aug 2026), with these changes:

- **Coffee** reorder point 0 → 2 kg, target 2 → 4 kg (a reorder point of 0 never warned
  until completely empty, and the target must sit above the warning level)
- **Targets raised to the level actually held on 26 Aug:** Paper cups 5 → 10, Plastic forks
  5 → 9, Tassay water 5 → 6, Sugar 12 → 14, Greenfield tea 5 → 6. The old targets sat below
  normal holding, so reorder suggestions would have under-ordered.
- **Milk** stays a threshold item (reorder 3, target 5 cartons). At that volume spoilage
  risk is small; revisit if cartons start expiring before use.

All of these are editable under Setup. With the 26 Aug quantities the app shows
1 `REORDER` (Coffee) / 3 `LOW` / 8 `OK` and no threshold warnings.

## Workbook import (6 Nov 2026)

You had no access to the stock for a fresh count, so the app was loaded from
`AHKE Stationery Stock (1).xlsx` instead: all 32 Weekly Log rows (24 Jun – 19 Oct 2026)
imported as counts marked *imported from workbook* in History. Blank cells stay unknown,
never zero; log columns were matched by heading, since their order differs from the Stock
sheet. Coffee thresholds were taken from the workbook (reorder 3 kg, target 10 kg).

Result reconciles exactly with the workbook: every current quantity matches, and the status
split is 1 `REORDER` (Plastic plates) / 2 `LOW` (Tassay water, Milk) / 9 `OK`.

`workbook-import-2026-10-19.json` is the import file. Setup → Import on any device loads
the same starting point (it replaces whatever that device holds).

## Decisions baked in

**Local-first.** There is no Google Workspace domain, so Apps Script cannot restrict a web
app audience by domain, cannot reliably report the operator's identity, and cannot both
authenticate a user and keep them out of the backing Sheet. Data lives in the browser
(`localStorage`, with persistent storage requested) and the whole persistence surface is the
`Storage` object — a server or Sheet backend swaps in there without the UI changing.

Accepted deliberately: device loss or cleared site data loses the history (hence export);
only the device holder sees stock; timestamps are device time.

**No `PENDING`/`ABANDONED` state machine, no script locks.** Single-threaded local writes
have no partial-write window. Operation ids double as idempotency keys.

**Opening balance.** A fresh install starts every item `UNKNOWN` until the first count. The
workbook import above was a deliberate exception, chosen because no physical count was possible.

**Immutable journal.** Counts, receipts and voids are never edited or deleted. Stock is
replayed from the journal: `COUNT` is an absolute baseline, `RECEIPT` a delta,
`RECEIPT_VOID` excludes the receipt it references.

**Orders are documents, not stock events.** Received quantities are derived from the
receipt operations referencing each line, so stock and orders cannot disagree.

## Verified

**Clicked through at phone size (375 × 812)**, every dialog included:

- opening count → second same-day count → duplicate dialog → *correction* → linked to the
  original, which stays in history
- prepare order → tick a LOW item → switch it to METRO → two independent draft orders
- copy list (clipboard blocked in the test browser → fallback dialog shown)
- mark ordered → receive 4 of 9 → `PARTIALLY RECEIVED`, stock up by 4
- void receipt: empty reason refused; with a reason, stock reverted and order back to
  `ORDERED`
- cancel remaining balance → `CANCELLED`, open-order badge decremented
- item editor: `target ≤ warn` refused with an error dialog; valid value saved
- import: corrupt file → *Backup rejected*, nothing changed; valid file after simulated data
  loss → *Replace* → stock restored exactly

**Offline:** service worker registered and cached the app shell; with the server stopped
(confirmed unreachable from outside the browser) the app reloaded fully with all data.
Updates arrive on the next online load without a hard refresh.

**Scripted** (logic): completion gating; step validation; `0` vs blank; over-receipt
refused; voiding a receipt that predates a later count leaves stock untouched; idempotent
appends; seven kinds of corrupt backup rejected; export produces
`ahke-stock-YYYY-MM-DD.json` as a download that passes the import validator; backup round-trip exact; desktop layout
(1280 px) centred with no overflow.

**Bugs found and fixed while testing:**

- a debounced draft save could fire after a count completed, resurrecting the cleared draft
- *Prepare order* rows were unusable at phone width (names wrapping a word per line,
  supplier dropdown off-screen) — controls moved to their own line
- item editor fields overflowed the dialog at phone width
- long error text overflowed the backup-rejected dialog
- voided receipts were labelled "superseded" in History
- without a service worker the browser served a stale cached `index.html` after updates —
  fixed by the network-first worker

## Not covered

- **A real phone.** All phone testing used an emulated 375 × 812 viewport with mouse
  clicks, not a touch device. The first real count is the remaining check.
- Deliberately not built: one-off requests, prices, price comparison, minimum-order
  warnings, reminders, notifications, spend reporting, invoice handoff.
