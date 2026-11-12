import { Hono } from "hono";
import { cors } from "hono/cors";
import { SignJWT, importPKCS8 } from "jose";

// ---------- config (all from Railway variables) ----------
const env = (k: string, d = "") => Bun.env[k] ?? d;
const TZ = () => env("CLINIC_TIMEZONE", "Europe/London");
const DURATION_MIN = () => parseInt(env("APPOINTMENT_DURATION_MINUTES", "30"), 10);
// Examples: "mon-fri 09:00-17:30"  |  "mon-fri 09:00-13:00,14:00-17:30; sat 09:00-12:00; sun closed"
const OPENING_HOURS = () => env("OPENING_HOURS", "mon-fri 09:00-17:30");
// Comma-separated closed dates, e.g. "2026-12-25,2026-12-28,2027-01-01"
const CLOSURES = () => new Set(env("CLOSURES", "").split(",").map((s) => s.trim()).filter(Boolean));
const MAX_DAYS_AHEAD = () => parseInt(env("MAX_DAYS_AHEAD", "90"), 10);
const MIN_LEAD_MINUTES = () => parseInt(env("MIN_LEAD_MINUTES", "60"), 10);
const GRID_MIN = 30; // appointments start on the hour or half hour

class CalendarError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- time helpers ----------
const hasOffset = (s: string) => /([zZ]|[+-]\d{2}:?\d{2})$/.test(s);

function tzOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, string> = Object.fromEntries(
    dtf.formatToParts(date).map((x) => [x.type, x.value]),
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

// Naive times (no offset) are interpreted as clinic-local wall-clock time.
function parseInstant(s: string): Date {
  if (hasOffset(s)) return new Date(s);
  const naive = new Date(s + "Z");
  if (isNaN(naive.getTime())) throw new Error(`Invalid datetime: ${s}`);
  return new Date(naive.getTime() - tzOffsetMinutes(naive, TZ()) * 60000);
}

// Clinic-local representations of an instant, so the agent never has to convert time zones.
function localNaive(d: Date): string {
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ(), hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
function localHuman(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ(), weekday: "long", day: "numeric", month: "long",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d);
}

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
function localDay(d: Date) {
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ(), weekday: "long", day: "numeric", month: "long",
      year: "numeric", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  const monthNum = new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), month: "2-digit" }).format(d);
  return {
    weekday: p.weekday,
    date: `${p.year}-${monthNum}-${String(p.day).padStart(2, "0")}`,
    spoken: `${p.weekday} the ${ordinal(+p.day)} of ${p.month}`,
    year: +p.year,
    time24: `${p.hour}:${p.minute}`,
  };
}

// Tolerant phone matching: compare the last 9 digits (ignores +44 / 0 / spaces / dashes).
const phoneKey = (p: string) => String(p ?? "").replace(/\D/g, "").slice(-9);

// ---------- opening hours ----------
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
type Win = { open: number; close: number }; // minutes from midnight

function parseOpeningHours(spec: string): Record<string, Win[]> {
  const hours: Record<string, Win[]> = {};
  for (const d of DAYS) hours[d] = []; // days not mentioned are closed
  for (const part of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([a-z]{3})(?:\s*-\s*([a-z]{3}))?\s+(.+)$/i);
    if (!m) throw new Error(`Invalid OPENING_HOURS segment: "${part}"`);
    const from = DAYS.indexOf(m[1].toLowerCase());
    const to = m[2] ? DAYS.indexOf(m[2].toLowerCase()) : from;
    if (from < 0 || to < 0) throw new Error(`Invalid day in OPENING_HOURS: "${part}"`);
    const wins: Win[] = [];
    if (m[3].trim().toLowerCase() !== "closed") {
      for (const r of m[3].split(",")) {
        const t = r.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
        if (!t) throw new Error(`Invalid time range in OPENING_HOURS: "${r.trim()}"`);
        wins.push({ open: +t[1] * 60 + +t[2], close: +t[3] * 60 + +t[4] });
      }
    }
    let i = from;
    for (;;) { hours[DAYS[i]] = wins; if (i === to) break; i = (i + 1) % 7; }
  }
  return hours;
}

function localParts(d: Date): { day: string; minutes: number } {
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ(), weekday: "short", hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return { day: String(p.weekday).toLowerCase().slice(0, 3), minutes: +p.hour * 60 + +p.minute };
}

// Returns null if the whole appointment is bookable, otherwise a reason the agent can say.
// Throws if OPENING_HOURS is misconfigured (never silently allows everything).
function bookingBlocker(start: Date, end: Date): string | null {
  const now = Date.now();
  if (start.getTime() < now) return "That time is in the past.";
  if (start.getTime() < now + MIN_LEAD_MINUTES() * 60_000) {
    return `Appointments need at least ${MIN_LEAD_MINUTES()} minutes' notice.`;
  }
  if (start.getTime() > now + MAX_DAYS_AHEAD() * 86_400_000) {
    return `Appointments can only be booked up to ${MAX_DAYS_AHEAD()} days ahead.`;
  }
  const hours = parseOpeningHours(OPENING_HOURS());
  const openText = `The practice is open: ${OPENING_HOURS()}.`;
  const s = localParts(start);
  const e = localParts(new Date(end.getTime() - 1));
  if (CLOSURES().has(localNaive(start).slice(0, 10))) return `The practice is closed on that date. ${openText}`;
  if (s.day !== e.day) return `That appointment would run past midnight. ${openText}`;
  if (s.minutes % GRID_MIN !== 0) return "Appointments start on the hour or half hour.";
  const wins = hours[s.day] ?? [];
  if (wins.length === 0) return `The practice is closed on that day. ${openText}`;
  if (!wins.some((w) => s.minutes >= w.open && e.minutes + 1 <= w.close)) {
    return `That time is outside opening hours. ${openText}`;
  }
  return null;
}

// ---------- Google Calendar (service account, REST) ----------
let cachedToken: { value: string; exp: number } | null = null;

// Safe diagnostics: describes the SHAPE of the value, never its content.
function describeShape(raw: string): string {
  const t = raw.trim();
  return [
    `length=${t.length}`,
    `firstChar=${JSON.stringify(t[0] ?? "")}`,
    `lastChar=${JSON.stringify(t[t.length - 1] ?? "")}`,
    `isPlaceholder=${t.startsWith("PLACEHOLDER")}`,
    `hasClientEmail=${t.includes("client_email")}`,
    `hasPrivateKey=${t.includes("private_key")}`,
    `looksLikeOAuthClientFile=${t.includes('"installed"') || t.includes('"web"')}`,
  ].join(", ");
}

// Very tolerant loader. Handles a value that is:
//  - the raw service-account JSON (possibly with junk before "{" / after "}")
//  - base64 of that JSON
//  - JSON with escaped quotes (\") or with real newlines inside private_key
function loadServiceAccount(raw: string): { client_email: string; private_key: string } {
  let text = raw.trim();

  if (!text.includes("client_email")) {
    try {
      const d = Buffer.from(text, "base64").toString("utf8").trim();
      if (d.includes("client_email")) text = d;
    } catch { /* keep original */ }
  }

  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s >= 0 && e > s) text = text.slice(s, e + 1);

  try {
    const sa = JSON.parse(text);
    if (sa?.client_email && sa?.private_key) {
      return { client_email: sa.client_email, private_key: sa.private_key };
    }
  } catch { /* fall through */ }

  const variants = [text, text.replace(/\\"/g, '"')];
  for (const v of variants) {
    const email = v.match(/"client_email"\s*:\s*"([^"]+)"/)?.[1];
    const keyRaw = v.match(/"private_key"\s*:\s*"([\s\S]*?-----END [A-Z ]*-----(?:\\+n|\n)?)"/)?.[1];
    if (email && keyRaw) {
      return { client_email: email, private_key: keyRaw.replace(/\\+n/g, "\n") };
    }
  }

  throw new CalendarError(
    "GOOGLE_SERVICE_ACCOUNT_JSON is not a valid service-account key (could not find client_email / private_key). " +
    `Diagnostics: ${describeShape(raw)}`,
  );
}

async function googleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;

  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) throw new CalendarError("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const sa = loadServiceAccount(raw);

  let key;
  try {
    key = await importPKCS8(sa.private_key, "RS256");
  } catch (e) {
    throw new CalendarError(`private_key in GOOGLE_SERVICE_ACCOUNT_JSON could not be parsed: ${(e as Error).message}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/calendar" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setSubject(sa.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body: any = await res.json();
  if (!res.ok || !body.access_token) {
    throw new CalendarError(`Google token exchange failed: ${JSON.stringify(body)}`);
  }
  cachedToken = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

function calendarId(): string {
  const id = env("GOOGLE_CALENDAR_ID");
  // "primary" is meaningless for a service account: events land in a calendar nobody sees.
  if (!id || id === "primary") {
    throw new CalendarError(
      "GOOGLE_CALENDAR_ID must be the clinic's real calendar ID (shared with the service account), not 'primary'.",
    );
  }
  return id;
}

// Busy intervals (epoch ms) between two instants, from the clinic calendar.
async function busyIntervals(from: Date, to: Date): Promise<{ start: number; end: number }[]> {
  const token = await googleAccessToken();
  const id = calendarId();
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeMin: from.toISOString(), timeMax: to.toISOString(),
      timeZone: TZ(), items: [{ id }],
    }),
  });
  const body: any = await res.json();
  if (!res.ok) throw new CalendarError(`freeBusy failed (${res.status}): ${JSON.stringify(body)}`);
  const cal = body.calendars?.[id];
  if (!cal) throw new CalendarError(`freeBusy returned no data for calendar: ${JSON.stringify(body)}`);
  if (cal.errors?.length) throw new CalendarError(`freeBusy calendar error: ${JSON.stringify(cal.errors)}`);
  return (cal.busy ?? []).map((b: any) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
}

async function isSlotFree(start: Date, end: Date): Promise<boolean> {
  return (await busyIntervals(start, end)).length === 0;
}

async function createEvent(a: {
  patient_name: string; phone_number: string; start: Date; end: Date; reason?: string;
}): Promise<{ id: string; htmlLink?: string }> {
  const token = await googleAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?sendUpdates=none`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: `Appointment — ${a.patient_name}`,
        description: `${a.reason ?? "Booked via DANTI voice agent"}\nPhone: ${a.phone_number}`,
        start: { dateTime: a.start.toISOString(), timeZone: TZ() },
        end: { dateTime: a.end.toISOString(), timeZone: TZ() },
      }),
    },
  );
  const body: any = await res.json();
  // THE FIX: a failed write is NEVER reported as success.
  if (!res.ok) throw new CalendarError(`Calendar insert failed (${res.status}): ${JSON.stringify(body)}`);
  if (!body?.id) throw new CalendarError(`Calendar insert returned no event id: ${JSON.stringify(body)}`);
  return { id: body.id, htmlLink: body.htmlLink };
}

// Deletes the event. 404/410 mean it is already gone, which is the desired end state.
async function deleteEvent(eventId: string): Promise<"deleted" | "already_gone"> {
  const token = await googleAccessToken();
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=none`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 204 || res.status === 200) return "deleted";
  if (res.status === 404 || res.status === 410) return "already_gone";
  throw new CalendarError(`Calendar delete failed (${res.status}): ${await res.text()}`);
}

// ---------- Calendar as a fallback source of truth ----------
// If Supabase is down or is missing a row, appointments can still be found from the calendar events
// that DANTI created (summary "Appointment — Name", description containing "Phone: ...").
async function calendarEventsBetween(from: Date, to: Date): Promise<any[]> {
  const token = await googleAccessToken();
  const params = new URLSearchParams({
    timeMin: from.toISOString(), timeMax: to.toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId())}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body: any = await res.json();
  if (!res.ok) throw new CalendarError(`Calendar list failed (${res.status}): ${JSON.stringify(body)}`);
  return body.items ?? [];
}
const isDantiEvent = (ev: any) =>
  String(ev.summary ?? "").startsWith("Appointment —") && ev.status !== "cancelled" && !!ev.start?.dateTime;
const eventPhoneKey = (ev: any) =>
  phoneKey(String(ev.description ?? "").match(/Phone:\s*([^\n]+)/)?.[1] ?? "");
function eventToAppt(ev: any) {
  return {
    source: "calendar",
    id: null as string | null,
    google_event_id: ev.id as string,
    start_time: new Date(ev.start.dateTime).toISOString(),
    patient_name: String(ev.summary).replace(/^Appointment —\s*/, ""),
    phone_number: String(ev.description ?? "").match(/Phone:\s*([^\n]+)/)?.[1]?.trim() ?? "",
    reason: String(ev.description ?? "").split("\n")[0] ?? "",
  };
}

// ---------- Supabase (PostgREST) ----------
// Supports both key formats:
//  - new "sb_secret_..." keys: NOT JWTs, sent in the `apikey` header only
//  - legacy service_role JWTs ("eyJ..."): also sent as a Bearer token
async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const headers: Record<string, string> = {
    apikey: key,
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

// Audit log with retries. NEVER blocks or breaks a booking. If it finally fails, a loud, greppable
// line with the full row is written so the record can be restored by hand.
async function logAppointment(row: Record<string, unknown>): Promise<boolean> {
  let lastErr: unknown = "unknown";
  for (const delay of [0, 400, 1500]) {
    if (delay) await sleep(delay);
    try {
      const res = await sb("appointments", { method: "POST", body: JSON.stringify(row) });
      if (res.ok) return true;
      lastErr = `${res.status} ${await res.text()}`;
      if (res.status >= 400 && res.status < 500) break; // a client error will not fix itself
    } catch (e) { lastErr = e; }
  }
  console.error("BOOKING_NOT_LOGGED_FIX_MANUALLY", JSON.stringify(row), String(lastErr));
  return false;
}

async function markCancelled(eventId: string): Promise<boolean> {
  let lastErr: unknown = "unknown";
  for (const delay of [0, 400, 1500]) {
    if (delay) await sleep(delay);
    try {
      const upd = await sb(
        `appointments?google_event_id=eq.${encodeURIComponent(eventId)}&status=eq.confirmed`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "cancelled" }) },
      );
      if (upd.ok) return true;
      lastErr = `${upd.status} ${await upd.text()}`;
      if (upd.status >= 400 && upd.status < 500) break;
    } catch (e) { lastErr = e; }
  }
  console.error("CANCELLED_BUT_NOT_LOGGED_FIX_MANUALLY google_event_id=", eventId, String(lastErr));
  return false;
}

// Finds a CONFIRMED appointment for this phone at (about) this time.
// Supabase first; if Supabase is down OR has no row, the calendar is consulted.
async function findAppointment(phone: string, start: Date): Promise<any | null> {
  const t = start.getTime();
  const want = phoneKey(phone);
  try {
    const path =
      "appointments?select=*&status=eq.confirmed" +
      `&start_time=gte.${encodeURIComponent(new Date(t - 60_000).toISOString())}` +
      `&start_time=lte.${encodeURIComponent(new Date(t + 60_000).toISOString())}`;
    const res = await sb(path);
    if (!res.ok) throw new Error(`lookup failed (${res.status}): ${await res.text()}`);
    const rows: any[] = await res.json();
    const row = rows.find((r) => phoneKey(r.phone_number) === want);
    if (row) return { ...row, source: "db" };
  } catch (e) {
    console.error("SUPABASE_UNREACHABLE (appointment lookup), falling back to calendar:", String(e));
  }
  const evs = await calendarEventsBetween(new Date(t - 60_000), new Date(t + 60_000));
  const ev = evs.find(
    (e) => isDantiEvent(e) && eventPhoneKey(e) === want && Math.abs(Date.parse(e.start.dateTime) - t) <= 60_000,
  );
  return ev ? eventToAppt(ev) : null;
}

// Upcoming appointments for a phone: union of Supabase and calendar, de-duplicated by calendar event id.
async function upcomingForPhone(phone: string): Promise<any[]> {
  const want = phoneKey(phone);
  const byEvent = new Map<string, any>();
  try {
    const res = await sb(
      "appointments?select=*&status=eq.confirmed&order=start_time.asc" +
      `&start_time=gte.${encodeURIComponent(new Date().toISOString())}`,
    );
    if (!res.ok) throw new Error(`lookup failed (${res.status}): ${await res.text()}`);
    const rows: any[] = await res.json();
    for (const r of rows) {
      if (phoneKey(r.phone_number) === want && r.google_event_id) byEvent.set(r.google_event_id, { ...r, source: "db" });
    }
  } catch (e) {
    console.error("SUPABASE_UNREACHABLE (upcoming lookup), using calendar only:", String(e));
  }
  try {
    const evs = await calendarEventsBetween(
      new Date(), new Date(Date.now() + (MAX_DAYS_AHEAD() + 7) * 86_400_000),
    );
    for (const ev of evs) {
      if (isDantiEvent(ev) && eventPhoneKey(ev) === want && !byEvent.has(ev.id)) byEvent.set(ev.id, eventToAppt(ev));
    }
  } catch (e) {
    console.error("calendar upcoming lookup failed:", String(e));
    if (byEvent.size === 0) throw e;
  }
  return [...byEvent.values()].sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

// ---------- VAPI helpers ----------
function parseVapi(body: any): { args: any; toolCallId?: string } {
  const tc = body?.message?.toolCalls?.[0];
  if (tc) {
    let args = tc.function?.arguments ?? {};
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    return { args, toolCallId: tc.id };
  }
  return { args: body };
}
const vapiResult = (id: string | undefined, result: unknown) =>
  id ? { results: [{ toolCallId: id, result }] } : { result };

// Malformed JSON bodies get a clear 400 instead of a bare 500.
async function readJson(c: any): Promise<any | null> {
  try { return await c.req.json(); } catch { return null; }
}

// ---------- slot search helpers ----------
function spokenTime(mins: number): string {
  const h = Math.floor(mins / 60), m = mins % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 12 ? "in the morning" : h < 18 ? "in the afternoon" : "in the evening";
  return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""} ${part}`;
}
function addDaysStr(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function pickSpread<T>(arr: T[], k: number): T[] {
  if (arr.length <= k) return arr;
  if (k === 1) return [arr[0]];
  const out: T[] = [];
  for (let i = 0; i < k; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
  return out;
}

// ---------- app ----------
const app = new Hono();
app.use("*", cors());

// Shared-secret guard for VAPI webhooks (enforced when VAPI_SHARED_SECRET is set).
app.use("/vapi/*", async (c, next) => {
  const secret = env("VAPI_SHARED_SECRET");
  if (secret) {
    const got = c.req.header("x-vapi-secret") ?? c.req.header("authorization")?.replace(/^Bearer /i, "");
    if (got !== secret) return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

// Dashboard endpoints expose patient data: secure by default (token required).
app.use("/dashboard/*", async (c, next) => {
  const token = env("DASHBOARD_TOKEN");
  if (!token) return c.json({ error: "DASHBOARD_TOKEN not configured" }, 503);
  const got = c.req.header("authorization")?.replace(/^Bearer /i, "");
  if (got !== token) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/", (c) => c.json({ service: "DANTI API", status: "running" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// Reports whether the database is reachable. Exposes status only, no data.
app.get("/health/db", async (c) => {
  try {
    const res = await sb("appointments?select=id&limit=1");
    return c.json({ db: res.ok ? "ok" : "error", status: res.status }, res.ok ? 200 : 503);
  } catch (e) {
    return c.json({ db: "unreachable" }, 503);
  }
});

// Real current date/time + a ready calendar of the next 21 days, so the agent never asks
// the caller "what's today's date?" and never does weekday arithmetic itself.
app.all("/vapi/current-time", async (c) => {
  const body = c.req.method === "POST" ? await readJson(c) : null;
  const toolCallId = body ? parseVapi(body).toolCallId : undefined;
  const now = new Date();
  const today = localDay(now);
  const upcoming = [];
  for (let i = 0; i < 21; i++) {
    const d = localDay(new Date(now.getTime() + i * 86_400_000));
    upcoming.push({
      weekday: d.weekday, date: d.date, spoken: d.spoken,
      label: i === 0 ? "today" : i === 1 ? "tomorrow" : "",
    });
  }
  return c.json(vapiResult(toolCallId, {
    timezone: TZ(),
    now_local: localNaive(now),
    time_24h: today.time24,
    today: { weekday: today.weekday, date: today.date, spoken: today.spoken, year: today.year },
    upcoming_days: upcoming,
    note: "Use these dates. Never ask the caller for today's date or the year. For tools, write start_time as YYYY-MM-DDTHH:MM:SS using a date from upcoming_days.",
  }));
});

// Finds REAL free appointment times (inside opening hours, not in the past, not on closures,
// not overlapping the calendar). If the requested day has none, it moves to the next day that does.
app.post("/vapi/find-slots", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "Request body is not valid JSON" }, 400);
  const { args, toolCallId } = parseVapi(body);
  let date = String(args.date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date is required, formatted YYYY-MM-DD" }, 422);
  }
  const part = String(args.part_of_day ?? "any").toLowerCase();
  const limit = Math.min(Math.max(parseInt(String(args.limit ?? "3"), 10) || 3, 1), 5);

  try {
    const hours = parseOpeningHours(OPENING_HOURS());
    const closures = CLOSURES();
    const now = Date.now();
    const earliest = now + MIN_LEAD_MINUTES() * 60_000;
    const latest = now + MAX_DAYS_AHEAD() * 86_400_000;
    const dur = DURATION_MIN();

    const todayStr = localNaive(new Date()).slice(0, 10);
    if (date < todayStr) date = todayStr; // never search the past

    const windowStart = parseInstant(`${date}T00:00:00`);
    const windowEnd = new Date(windowStart.getTime() + 9 * 86_400_000);
    const busy = await busyIntervals(windowStart, windowEnd);

    for (let i = 0; i < 8; i++) {
      const dayStr = addDaysStr(date, i);
      if (closures.has(dayStr)) continue;
      const noon = parseInstant(`${dayStr}T12:00:00`);
      const key = localDay(noon).weekday.slice(0, 3).toLowerCase();
      const wins = hours[key] ?? [];
      if (wins.length === 0) continue;

      const free: { start_time_for_tool: string; spoken: string }[] = [];
      for (const w of wins) {
        for (let m = Math.ceil(w.open / GRID_MIN) * GRID_MIN; m + dur <= w.close; m += GRID_MIN) {
          if (part === "morning" && m >= 12 * 60) continue;
          if (part === "afternoon" && m < 12 * 60) continue;
          const hh = String(Math.floor(m / 60)).padStart(2, "0");
          const mm = String(m % 60).padStart(2, "0");
          const start = parseInstant(`${dayStr}T${hh}:${mm}:00`);
          const end = new Date(start.getTime() + dur * 60_000);
          if (start.getTime() < earliest || start.getTime() > latest) continue;
          if (busy.some((b) => start.getTime() < b.end && end.getTime() > b.start)) continue;
          free.push({ start_time_for_tool: `${dayStr}T${hh}:${mm}:00`, spoken: spokenTime(m) });
        }
      }
      if (free.length > 0) {
        return c.json(vapiResult(toolCallId, {
          found: true,
          date: dayStr,
          spoken_date: localDay(noon).spoken,
          requested_date_had_no_slots: i > 0,
          slots: pickSpread(free, limit),
          total_free_that_day: free.length,
        }));
      }
    }
    return c.json(vapiResult(toolCallId, {
      found: false,
      message: `No free appointments were found in the 8 days from ${date}` +
        (part !== "any" ? ` for the ${part}` : "") + ". Offer to look at a later week or give the practice phone number.",
    }));
  } catch (e) {
    console.error("find-slots failed:", e);
    return c.json({ error: `Slot search failed: ${(e as Error).message}` }, 502);
  }
});

app.post("/vapi/check-availability", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "Request body is not valid JSON" }, 400);
  const { args, toolCallId } = parseVapi(body);
  try {
    if (!args.start_time) return c.json({ error: "start_time is required" }, 422);
    const start = parseInstant(args.start_time);
    const end = args.end_time ? parseInstant(args.end_time) : new Date(start.getTime() + DURATION_MIN() * 60000);

    // Opening hours, closures, past times and the booking horizon are enforced HERE, not only in the prompt.
    const blocker = bookingBlocker(start, end);
    if (blocker) {
      return c.json(vapiResult(toolCallId, { available: false, reason: "not_bookable", message: blocker }));
    }

    const free = await isSlotFree(start, end);
    return c.json(vapiResult(toolCallId, {
      available: free,
      message: free ? "Slot is available." : "Slot is already booked.",
    }));
  } catch (e) {
    console.error("check-availability failed:", e);
    return c.json({ error: `Calendar check failed: ${(e as Error).message}` }, 502);
  }
});

app.post("/vapi/book-appointment", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "Request body is not valid JSON" }, 400);
  const { args, toolCallId } = parseVapi(body);
  if (!args.patient_name || !args.phone_number || !args.start_time) {
    return c.json({ error: "patient_name, phone_number and start_time are required" }, 422);
  }
  let start: Date, end: Date;
  try {
    start = parseInstant(args.start_time);
    end = args.end_time ? parseInstant(args.end_time) : new Date(start.getTime() + DURATION_MIN() * 60000);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }

  try {
    // IDEMPOTENCY: an existing confirmed appointment for this phone at this time (found in Supabase,
    // or in the calendar if Supabase is down/missing it) means this is a retry. Return success, never a duplicate.
    try {
      const existing = await findAppointment(args.phone_number, start);
      if (existing) {
        return c.json(vapiResult(toolCallId, {
          success: true,
          already_booked: true,
          message: `This appointment was already booked for ${existing.patient_name}.`,
          google_event_id: existing.google_event_id,
        }));
      }
    } catch (e) {
      console.error("idempotency lookup failed (continuing):", String(e));
    }

    // Hard guard: never book outside opening hours / closures / past / horizon, whatever the agent decided.
    const blocker = bookingBlocker(start, end);
    if (blocker) {
      // HTTP 200 on purpose: a normal outcome the agent must be able to read and speak.
      return c.json(vapiResult(toolCallId, { success: false, message: blocker }));
    }

    // Re-check right before writing: avoids double-booking between check and book.
    if (!(await isSlotFree(start, end))) {
      void logAppointment({
        patient_name: args.patient_name, phone_number: args.phone_number,
        start_time: start.toISOString(), end_time: end.toISOString(),
        status: "failed", reason: args.reason ?? null, error_message: "Slot already booked",
      });
      return c.json(vapiResult(toolCallId, {
        success: false, message: "That slot has just been taken. Please offer another time.",
      }));
    }
    const event = await createEvent({
      patient_name: args.patient_name, phone_number: args.phone_number,
      start, end, reason: args.reason,
    });
    // Logged as confirmed ONLY after Google has confirmed the event exists. Logging (with retries)
    // runs in the background so a slow or unreachable database never delays or breaks the call.
    void logAppointment({
      patient_name: args.patient_name, phone_number: args.phone_number,
      start_time: start.toISOString(), end_time: end.toISOString(),
      status: "confirmed", google_event_id: event.id, reason: args.reason ?? null,
    });
    return c.json(vapiResult(toolCallId, {
      success: true,
      message: `Appointment confirmed for ${args.patient_name}.`,
      google_event_id: event.id,
      google_event_link: event.htmlLink,
    }));
  } catch (e) {
    console.error("book-appointment failed:", e);
    void logAppointment({
      patient_name: args.patient_name, phone_number: args.phone_number,
      start_time: start.toISOString(), end_time: end.toISOString(),
      status: "failed", reason: args.reason ?? null, error_message: (e as Error).message,
    });
    return c.json({ error: `Booking failed: ${(e as Error).message}` }, 502);
  }
});

// Cancel is two-step and SAFE:
//  - WITHOUT start_time: lookup only. Nothing is ever cancelled. Returns the caller's upcoming
//    appointment times so the agent can confirm one with the caller.
//  - WITH start_time: cancels exactly that appointment (phone + time must both match).
// Works even if Supabase is down or missing the row: the calendar is the fallback.
app.post("/vapi/cancel-appointment", async (c) => {
  const body = await readJson(c);
  if (!body) return c.json({ error: "Request body is not valid JSON" }, 400);
  const { args, toolCallId } = parseVapi(body);
  if (!args.phone_number) return c.json({ error: "phone_number is required" }, 422);

  try {
    // ---- lookup mode (no mutation) ----
    if (!args.start_time) {
      const rows = await upcomingForPhone(args.phone_number);
      if (rows.length === 0) {
        return c.json(vapiResult(toolCallId, {
          success: false, nothing_cancelled: true,
          message: "No upcoming confirmed appointment was found for that phone number.",
        }));
      }
      // Only times are returned (no names) to avoid leaking personal details to a caller.
      return c.json(vapiResult(toolCallId, {
        success: false, nothing_cancelled: true, needs_start_time: true,
        message:
          "NOTHING HAS BEEN CANCELLED. Upcoming appointment(s) found. Confirm with the caller which one to cancel, " +
          "then call this tool again with that start_time.",
        appointments: rows.map((r) => {
          const d = new Date(r.start_time);
          return { start_time_for_tool: localNaive(d), spoken: localHuman(d) };
        }),
      }));
    }

    // ---- cancel mode (exact appointment) ----
    const appt = await findAppointment(args.phone_number, parseInstant(args.start_time));
    if (!appt) {
      return c.json(vapiResult(toolCallId, {
        success: false, nothing_cancelled: true,
        message: "No confirmed appointment was found for that phone number at that time.",
      }));
    }
    if (!appt.google_event_id) {
      return c.json({ error: "This appointment has no calendar event id, so it cannot be cancelled automatically." }, 502);
    }

    // 1) Calendar is the source of truth: delete there first.
    const outcome = await deleteEvent(appt.google_event_id);

    // 2) Then mark it cancelled in Supabase in the background (with retries and loud failure logging).
    void markCancelled(appt.google_event_id);

    return c.json(vapiResult(toolCallId, {
      success: true,
      message: `The appointment on ${localHuman(new Date(appt.start_time))} has been cancelled.`,
      calendar: outcome,
    }));
  } catch (e) {
    console.error("cancel-appointment failed:", e);
    return c.json({ error: `Cancellation failed: ${(e as Error).message}` }, 502);
  }
});

app.get("/dashboard/appointments", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  try {
    const res = await sb(`appointments?select=*&order=start_time.desc&limit=${limit}`);
    if (!res.ok) return c.json({ error: await res.text() }, 502);
    return c.json(await res.json());
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.get("/dashboard/stats", async (c) => {
  try {
    const res = await sb("appointments?select=status");
    if (!res.ok) return c.json({ error: await res.text() }, 502);
    const rows: { status: string }[] = await res.json();
    return c.json({
      confirmed: rows.filter((r) => r.status === "confirmed").length,
      failed: rows.filter((r) => r.status === "failed").length,
      cancelled: rows.filter((r) => r.status === "cancelled").length,
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Light database keep-alive (startup + every 6 hours) so an idle project is less likely to be paused,
// and so an unreachable database shows up clearly in the logs.
// NOTE: Railway recommends a cron schedule instead of a top-level setInterval. If your Supabase plan
// does not pause idle projects, you can delete this block.
const keepalive = async () => {
  try {
    const r = await sb("appointments?select=id&limit=1");
    if (!r.ok) console.error("SUPABASE_KEEPALIVE_FAILED status", r.status);
  } catch (e) {
    console.error("SUPABASE_UNREACHABLE (keepalive):", String(e));
  }
};
setInterval(keepalive, 6 * 60 * 60 * 1000);
void keepalive();

export default {
  port: Number(Bun.env.PORT ?? 8000),
  fetch: app.fetch,
};
