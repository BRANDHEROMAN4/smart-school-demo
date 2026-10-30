-- EDUVIA — اتجاه عبور البوابة وإشعارات الخروج
-- يُنفَّذ يدويًا في Supabase SQL Editor قبل النشر.

alter table public.gate_log
  add column if not exists direction text not null default 'entry';

alter table public.attendance
  add column if not exists entry_time text,
  add column if not exists exit_time text;

-- WhatsApp هو قناة إرسال حقيقية؛ لا تُخزن الأسرار في الواجهة أو Git.
do $$
begin
  alter type public.msg_channel add value if not exists 'whatsapp';
exception when duplicate_object then null;
end $$;

alter table public.outbox add column if not exists error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.gate_log'::regclass
      and conname = 'gate_log_direction_chk'
  ) then
    alter table public.gate_log add constraint gate_log_direction_chk
      check (direction in ('entry','exit'));
  end if;
end $$;

create index if not exists gate_log_student_day_direction_idx
  on public.gate_log(student_id, day, direction, created_at desc);

comment on column public.gate_log.direction is
  'اتجاه عبور التلميذة: entry دخول، exit خروج؛ ولا تعتبر عملية الخروج حضورًا جديدًا.';
comment on column public.attendance.entry_time is 'وقت أول دخول مسجّل للتلميذة في اليوم.';
comment on column public.attendance.exit_time is 'آخر وقت خروج مسجّل للتلميذة في اليوم.';
