# DANTI: AI voice reception for dental practices

A voice agent (VAPI) answers a practice's phone, finds real free times, and books, cancels and changes
appointments on the practice's Google Calendar. Every booking is logged in Supabase and shown in a staff dashboard.

```
Caller ─► VAPI (speaker + reasoner) ─► API (Railway Function) ─► Google Calendar  (source of truth)
                                                            └──► Supabase        (audit log, dashboard)
Staff ──► Dashboard (Railway Function, static) ──► API /dashboard/*  (access key)
```

## Repository layout

| Path | What it is |
|---|---|
| `api/index.tsx` | The API: single-file Bun + Hono service, deployed as a Railway Function (`danti-api`) |
| `dashboard-standalone/` | The staff dashboard source: plain HTML/CSS/JS, no build step |
| `dashboard-function/index.tsx` | GENERATED single-file Railway Function that serves the dashboard (`danti-dashboard`) |
| `scripts/build-dashboard-function.js` | Regenerates `dashboard-function/index.tsx` from `dashboard-standalone/` |
| `supabase/schema.sql` | Database schema (tables, indexes, RLS) |
| `docs/tools.md`, `docs/prompts/` | Voice-agent tool definitions and the speaker / reasoner prompts |

## What the API guarantees

- A booking is reported as successful **only** after Google Calendar has created the event. Calendar errors are never swallowed (the original silent-failure bug).
- Opening hours, closures, past times, minimum notice, the booking horizon and the 30-minute grid are enforced in code, not in the prompt.
- Booking is idempotent: a retry after a timeout returns `already_booked` instead of creating a duplicate.
- Cancelling is two-step: without `start_time` it only looks up; it cancels only an exact phone + time match.
- If Supabase is down or missing a row, lookups fall back to the calendar events DANTI created. Failed log writes are retried and then reported with a greppable line (`BOOKING_NOT_LOGGED_FIX_MANUALLY`).

## Endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /health`, `GET /health/db` | none | Liveness; database reachability (status only) |
| `POST /vapi/current-time` | `x-vapi-secret` | Real UK date/time and the next 21 days |
| `POST /vapi/find-slots` | `x-vapi-secret` | Real free times |
| `POST /vapi/check-availability` | `x-vapi-secret` | One exact time |
| `POST /vapi/book-appointment` | `x-vapi-secret` | Book (idempotent) |
| `POST /vapi/cancel-appointment` | `x-vapi-secret` | Look up, or cancel an exact appointment |
| `GET /dashboard/appointments`, `GET /dashboard/stats` | `Authorization: Bearer <DASHBOARD_TOKEN>` | Dashboard data |

## Configuration (Railway variables on `danti-api`)

Never commit these. The repository contains no secrets.

| Variable | Notes |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service-account key (raw JSON or base64). Share the clinic calendar with its `client_email` ("Make changes to events"). |
| `GOOGLE_CALENDAR_ID` | The clinic calendar's real ID. Never `primary`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Accepts new `sb_secret_...` keys and legacy `service_role` JWTs. |
| `VAPI_SHARED_SECRET` | Sent by VAPI as header `x-vapi-secret`. |
| `DASHBOARD_TOKEN` | The staff access key. Without it the dashboard endpoints return 503. |
| `CLINIC_TIMEZONE` | Default `Europe/London`. |
| `OPENING_HOURS` | e.g. `mon-fri 09:00-13:00,14:00-17:30; sat 09:00-12:00; sun closed` (default `mon-fri 09:00-17:30`). |
| `CLOSURES` | Comma-separated closed dates, e.g. `2026-12-25,2026-12-28`. |
| `MAX_DAYS_AHEAD` / `MIN_LEAD_MINUTES` / `APPOINTMENT_DURATION_MINUTES` | Defaults `90` / `60` / `30`. |

The dashboard function has one optional variable, `API_ORIGIN` (defaults to the production API), used in its Content-Security-Policy.

## Deploying (Railway Functions)

1. Create a Railway project. Add a function service for `api/index.tsx` and another for `dashboard-function/index.tsx`.
2. Generate a public domain for each. Set the variables above on the API service.
3. Apply `supabase/schema.sql` to the Supabase project.
4. In VAPI create the tools in `docs/tools.md` (URL + header `x-vapi-secret`) and use the prompts in `docs/prompts/`.

Changing the dashboard: edit `dashboard-standalone/*`, run `node scripts/build-dashboard-function.js`, and redeploy `dashboard-function/index.tsx`.
If the API's public URL changes, update `API` at the top of `dashboard-standalone/app.js` and the `API_ORIGIN` variable.

## Dashboard access

The dashboard asks for an access key (`DASHBOARD_TOKEN`). It is one shared key, not per-user accounts, and has no lockout.
Keep the key long and random, and rotate it by changing the Railway variable. Per-user login (Supabase Auth) is a planned improvement.

## Known limitations

- Public holidays are not known to the system. List them in `CLOSURES`.
- Cancelling relies on phone number + time, not on verifying identity.
- No callback, message-taking, call transfer or reminders.
- `api/index.tsx` has a top-level `setInterval` keep-alive; Railway recommends cron schedules instead. Remove it if Supabase does not pause idle projects on your plan.
- Supabase free projects can pause after a week of inactivity; use a paid plan for a real practice.
