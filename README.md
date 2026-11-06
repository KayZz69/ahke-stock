# AHKE Stock

Stock tool for the AHKE stationery cupboard. One Cloudflare Worker serves the app and an
append-only event log in D1, all behind one password. Works offline, installs to a phone
home screen, and syncs between devices.

## How it fits together

| Path | What it is |
|---|---|
| `public/` | the app: `index.html`, `login.html`, service worker, manifest, icons |
| `src/worker.js` | the Worker: password check, sessions, `/api/sync`, serves `public/` |
| `migrations/` | D1 schema — `events` table and login rate-limit table |
| `wrangler.toml` | Cloudflare config |

**Access.** Every page and all data need a session. Only the login page and the install
files (manifest, icons, service worker) are public; none contain stock data. The session is
a signed `HttpOnly; Secure; SameSite=Lax` cookie valid for 180 days. Ten wrong passwords
from one IP lock that IP out for 15 minutes.

**Sync.** Every change — a count, a receipt, an order step, an item edit — is an immutable
record with its own id. Each device sends what it has that the server lacks and receives what
it is missing, so merging is a set union with nothing to reconcile. It runs on load, shortly
after each change, when the connection returns, when the app comes to the front, and every
minute. The header shows *Synced*, *Offline · N to send*, or *Sign in to sync*.

**Offline.** The app opens from its offline copy without signal; changes queue up and send
when the connection returns. Two devices editing offline merge cleanly: both counts are kept
(the later one sets current stock), and two cancellations of the same balance never cancel
more than was open.

**Signing out** keeps the data on that device by default. *Sign out and erase this device*
removes the stock data and offline copy from it (refused while changes are still unsent).

## Deploying to Cloudflare

One-time setup, from this folder:

```bash
npm install
npx wrangler login                     # opens Cloudflare in the browser
npx wrangler d1 create ahke-stock      # copy the database_id it prints into wrangler.toml
npm run db:remote                      # create the tables
npx wrangler secret put APP_PASSWORD   # type the password you want (not stored in git)
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put SESSION_SECRET
npm run deploy                         # prints the https://ahke-stock.<you>.workers.dev URL
```

Later updates are just `npm run deploy`. Change the password with
`npx wrangler secret put APP_PASSWORD`; set a new `SESSION_SECRET` the same way to sign every
device out.

## Local development

```bash
npm install
npm run db:local
npm run dev            # http://localhost:8787
```

Local secrets live in `.dev.vars` (gitignored): `APP_PASSWORD=...` and `SESSION_SECRET=...`.

### On your phone

Open the Worker URL, sign in, then add it to the home screen:

- **Android / Chrome:** menu → *Install app*
- **iPhone / Safari:** Share → *Add to Home Screen* (sign in once more inside the installed
  app — iOS keeps its cookies separate from Safari)

To load the workbook history, use Setup → Import with `workbook-import-2026-10-19.json` on
any one signed-in device; it syncs to the others. Import only ever adds records — anything
already present is skipped, nothing is deleted.

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
the same starting point (it adds to what is there; nothing is replaced).

## Decisions baked in

**Cloudflare, not Google Apps Script.** There is no Google Workspace domain, so Apps Script
cannot restrict an audience by domain or reliably identify the user. A Worker with one
password and a signed cookie is simpler and fails closed: with `APP_PASSWORD` or
`SESSION_SECRET` unset it refuses every request.

**No `PENDING`/`ABANDONED` state machine, no locks.** Each upload is one atomic D1 batch of
`INSERT OR IGNORE`, and record ids are idempotency keys, so a retried or doubled upload can
never duplicate anything. Timestamps are device time.

**Opening balance.** A fresh install starts every item `UNKNOWN` until the first count. The
workbook import above was a deliberate exception, chosen because no physical count was possible.

**Local-first with sync.** The device's copy of the log (localStorage) is what the screens
read, so the app is instant and works offline. The server is the meeting point between
devices and the off-device backup, not a dependency for using the app.

**Immutable journal.** Counts, receipts and voids are never edited or deleted. Stock is
replayed from the journal: `COUNT` is an absolute baseline, `RECEIPT` a delta,
`RECEIPT_VOID` excludes the receipt it references.

**Orders are built from records too.** An order is the replay of its `ORDER_CREATED`,
`ORDER_CONFIRMED`, `ORDER_CANCELLED` and `ORDER_DELETED` records; received quantities come
from the receipts referencing each line, so stock and orders cannot disagree. Item edits are
`ITEM_UPDATED` records on top of the defaults in `index.html`.

## Verified

**Server (scripted, 25/25 against the local Worker):** pages and `/api/sync` refuse access
without a session; login page and install files are public; wrong password → 401; correct
password → `HttpOnly; Secure; SameSite=Lax` cookie; tampered or expired cookies refused;
cross-site requests refused; unknown record types and injection-shaped ids rejected;
resending the same record never duplicates it; 10 failures lock an IP out (others
unaffected); logout clears the cookie; security headers present.

**Two devices** (`localhost` and `127.0.0.1`, which keep separate storage and cookies):

- device A imports the workbook backup (old format, converted) → 32 records uploaded →
  device B signs in and pulls the identical stock picture
- B creates and confirms an order → A sees it with its reference → A receives 2 of 3 →
  B sees `PARTIALLY RECEIVED` and the stock change
- B edits an item target → A picks it up and its warning clears
- both go offline, both cancel the same remaining pack and both record a count → on
  reconnect both converge on the same 40 records: order `CLOSED SHORT` with the pack
  cancelled once, both counts kept, the later one setting stock
- server stopped → B reopens from its offline copy, records a count ("Offline · 1 to
  send") → server back → sent → A sees it
- sign out → login page; app and API refuse; local data kept. *Sign out and erase* → local
  data and offline app copy gone → sign in again → everything restored from the server

The browser automation will not type into password fields, so test sign-ins went through
the login API with a throwaway local password; the login page's error message was checked
with a dummy value.

**Earlier, single-device (before sync):**

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
