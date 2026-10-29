# Daily Bulletin

A [Hilltoppers](https://github.com/daniezl/Hilltoppers) topping — an independently
hosted mini-app that shows the newest Daily Bulletin from
[stjacademy.org](https://stjacademy.org/a-culture-of-caring-and-respect/sja-news/daily-bulletin/)
without opening the school site. One Cloudflare Worker serves the page, reads the
bulletin, and keeps a copy in D1 so a second visit does not wait on a scrape.

## How it works

```
 visitor ──► Worker ──► D1: is there a bulletin from the last 10 minutes?
                        │
                        ├─ yes ──► return it               (~15 ms)
                        └─ no  ──► fetch stjacademy.org    (~1–3 s)
                                   parse .latest-article
                                   ├─ ok ──► store in D1, return it
                                   └─ blocked ──► Firecrawl (if key set)
                                      └─ fails ──► return the stored copy, marked stale
```

- **Direct first.** The school's page renders the bulletin in server HTML, so a
  plain request plus a parser is enough and costs nothing. Firecrawl is only a
  fallback for when the school's edge turns the Worker away.
- **One scrape at a time.** `fetch_state.last_attempt_at` is claimed with a
  conditional `UPDATE` before any request goes out, so ten students opening the
  popup together still cost one scrape.
- **Today's copy is never withheld.** Once the current day's bulletin is stored, a
  re-check runs behind the response instead of in front of it.
- **Stale beats blank.** If the scrape fails, whatever was read last is served with
  `stale: true` and the page says so.
- **Dates are Vermont dates.** `America/New_York`, not UTC, decides what "today" is.

## API

`GET /api/bulletin` — the newest bulletin. `?refresh=1` asks for a re-check (the
scrape lock still applies).

```json
{
  "bulletin": {
    "date": "2026-10-28",
    "dateText": "October 28, 2026",
    "weekday": "Wednesday",
    "dayColor": "Green Day",
    "title": "Daily Bulletin",
    "blocks": [{ "type": "p", "text": "Tomorrow will be a school photo day…" }],
    "source": "direct",
    "sourceUrl": "https://stjacademy.org/…/daily-bulletin/",
    "fetchedAt": 1761667200000
  },
  "today": "2026-10-28",
  "isToday": true,
  "cached": true,
  "stale": false,
  "checking": false,
  "ageSeconds": 12,
  "lastSuccessAt": 1761667200000,
  "error": null
}
```

`503` with `{"bulletin": null, "error": "…"}` only happens when nothing is stored
and the scrape fails. `GET /api/health` reports whether D1 and Firecrawl are wired up.

`blocks` are `p`, `h` (a subhead) or `li`, already flattened to text — the page
never renders HTML from the school site, so nothing there can inject into this one.

## Local

```sh
npm ci
npm run db:init     # creates the local D1 tables
npm run dev         # http://localhost:8791
npm run typecheck
npm test
```

`npm run db:init` needs the D1 binding in `wrangler.toml`; the placeholder id is
fine locally. Without a `D1_DATABASE_ID` secret in CI the config is deployed with
no database at all, and the Worker scrapes on every visit instead of caching.

The Firecrawl key is a secret, never a var:

```sh
npx wrangler secret put FIRECRAWL_API_KEY
```

## Deploy

`.github/workflows/deploy.yml` deploys on every push to `main` after typecheck and
tests. It needs three repository secrets:

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with **Workers Scripts: Edit** and **D1: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Account id from the Cloudflare dashboard |
| `D1_DATABASE_ID` | Output of `npx wrangler d1 create bulletin` |

The workflow applies `migrations/0001_init.sql` before deploying, so the schema is
created (or left alone) on every push.

## Publishing it as a topping

1. Open the live URL and copy its origin.
2. In the extension's Topping Bar, publish a listing with that URL, a **fixed**
   height (the bulletin scrolls inside its card), and an icon — `bell` or `book`
   fit the content.
3. Publishing needs a verified SJA account and a public author name.

## Things worth knowing

- The parser keys off `.latest-article`, `.peapod-stripper`, `<h2>`, `.date` and
  the subhead. A theme change on the school site is the most likely break, and the
  fallbacks (`peapod-stripper` alone, then Firecrawl markdown) exist to cover it.
- `blocks` are text only. Links inside a bulletin keep their words and lose their
  hrefs; that was a deliberate trade for never rendering school HTML.
- Bulletins are stored one row per date, newest 30 kept.
