-- DANTI: appointments + call event audit log (already applied to the live Supabase project).
create table if not exists appointments (
    id uuid primary key default gen_random_uuid(),
    patient_name text not null,
    phone_number text not null,
    start_time timestamptz not null,
    end_time timestamptz not null,
    status text not null check (status in ('confirmed', 'failed', 'cancelled')),
    google_event_id text,
    reason text,
    error_message text,
    created_at timestamptz not null default now()
);

create index if not exists idx_appointments_phone on appointments (phone_number);
create index if not exists idx_appointments_start on appointments (start_time);
create index if not exists idx_appointments_status on appointments (status);
create index if not exists idx_appointments_event on appointments (google_event_id);

create table if not exists call_events (
    id uuid primary key default gen_random_uuid(),
    call_id text not null,
    event_type text not null,
    payload jsonb,
    created_at timestamptz not null default now()
);

create index if not exists idx_call_events_call_id on call_events (call_id);

alter table appointments enable row level security;
alter table call_events enable row level security;

-- Only the service role (used by the API on Railway) can read or write.
-- The dashboard never talks to Supabase directly: it goes through the API with an access key.
create policy "service role full access appointments" on appointments
    for all using (auth.role() = 'service_role');

create policy "service role full access call_events" on call_events
    for all using (auth.role() = 'service_role');
