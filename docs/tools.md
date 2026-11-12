# Voice-agent tools (VAPI / reasoner)

All tools are HTTP POST to the API with the header `x-vapi-secret: <VAPI_SHARED_SECRET>`.
Base URL: `https://danti-api-production.up.railway.app`

| Tool | URL | Purpose |
|---|---|---|
| `get_current_time` | `/vapi/current-time` | Real UK date/time + the next 21 days. Call once per call. Never ask the caller for the date. |
| `find_slots` | `/vapi/find-slots` | Real free times on a day, inside opening hours. Moves to the next day with space. |
| `check_availability` | `/vapi/check-availability` | One exact time. Also rejects closed / past / out-of-hours times. |
| `book_appointment` | `/vapi/book-appointment` | Books. Idempotent: a retry returns `already_booked`. |
| `cancel_appointment` | `/vapi/cancel-appointment` | Without `start_time` it only looks up. With `start_time` it cancels that appointment. |

## Parameter schemas (paste into the tool's "Parameters" box)

`get_current_time`
```json
{ "type": "object", "properties": {} }
```

`find_slots`
```json
{
  "type": "object",
  "properties": {
    "date": { "type": "string", "description": "The day to search, YYYY-MM-DD, taken from get_current_time's upcoming_days." },
    "part_of_day": { "type": "string", "description": "Optional: morning, afternoon or any." },
    "limit": { "type": "string", "description": "Optional: how many times to return, 1 to 5. Default 3." }
  },
  "required": ["date"]
}
```

`check_availability`
```json
{
  "type": "object",
  "properties": {
    "start_time": { "type": "string", "description": "UK local time like 2026-11-03T14:30:00, no timezone suffix." }
  },
  "required": ["start_time"]
}
```

`book_appointment`
```json
{
  "type": "object",
  "properties": {
    "patient_name": { "type": "string", "description": "Full name of the patient." },
    "phone_number": { "type": "string", "description": "Phone number, ideally international format, e.g. +447700900123." },
    "start_time": { "type": "string", "description": "UK local time like 2026-11-03T14:30:00, no timezone suffix." },
    "reason": { "type": "string", "description": "Short general reason plus whether new or existing patient." }
  },
  "required": ["patient_name", "phone_number", "start_time"]
}
```

`cancel_appointment`
```json
{
  "type": "object",
  "properties": {
    "phone_number": { "type": "string", "description": "Phone number the appointment was booked under." },
    "start_time": { "type": "string", "description": "UK local time of the appointment. Omit to only look up; nothing is cancelled without it." }
  },
  "required": ["phone_number"]
}
```

## Suggested tool descriptions
- `check_availability`: Checks ONE exact time. Also rejects times outside opening hours, in the past, or on closures (it then returns available false with the reason).
- `book_appointment`: Books an appointment. Only after the caller clearly confirmed. Safe to retry once: a duplicate is ignored and returned as success with already_booked. Refuses times outside opening hours.
- `cancel_appointment`: Without start_time it only looks up the number's upcoming appointments and cancels nothing. With start_time it cancels exactly that appointment.
