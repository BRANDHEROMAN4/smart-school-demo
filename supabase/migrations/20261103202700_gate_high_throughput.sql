-- Preserve exact gate crossing timestamps and make high-volume uploads retry-safe.
alter table public.gate_log
  add column if not exists captured_at timestamptz;

update public.gate_log
set captured_at = coalesce(captured_at, created_at)
where captured_at is null;

create unique index if not exists gate_log_client_id_uidx
  on public.gate_log(client_id)
  where client_id is not null;

create index if not exists gate_log_student_day_time_idx
  on public.gate_log(student_id, day, captured_at desc, created_at desc);

comment on column public.gate_log.captured_at is
  'Exact device clock timestamp (ISO UTC instant) captured when the crossing was recorded.';
