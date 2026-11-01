-- EDUVIA staff gate MVP: QR/NFC identifiers and entry/exit audit records.

create table if not exists public.staff_cards (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  card_no text not null,
  method text not null check (method in ('qr','nfc')),
  active boolean not null default true,
  issued_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists staff_cards_school_card_key
  on public.staff_cards(school_id, upper(card_no));
create index if not exists staff_cards_staff_idx on public.staff_cards(staff_id);

create table if not exists public.staff_gate_log (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  staff_id uuid not null references public.staff(id) on delete cascade,
  card_id uuid not null references public.staff_cards(id) on delete restrict,
  direction text not null check (direction in ('entry','exit')),
  method text not null check (method in ('qr','nfc','manual','simulated')),
  device_id text,
  client_id text,
  recorded_by uuid references public.profiles(id) on delete set null,
  at_time text not null,
  day date not null default current_date,
  created_at timestamptz not null default now()
);

create unique index if not exists staff_gate_client_id_key
  on public.staff_gate_log(client_id) where client_id is not null;
create index if not exists staff_gate_day_idx on public.staff_gate_log(school_id, day);

alter table public.staff_cards enable row level security;
alter table public.staff_gate_log enable row level security;

drop policy if exists staff_cards_read on public.staff_cards;
create policy staff_cards_read on public.staff_cards for select to authenticated
  using (school_id = public.my_school() and public.is_staff());

drop policy if exists staff_cards_write on public.staff_cards;
create policy staff_cards_write on public.staff_cards for all to authenticated
  using (school_id = public.my_school() and public.my_role() = 'director')
  with check (school_id = public.my_school() and public.my_role() = 'director');

drop policy if exists staff_gate_read on public.staff_gate_log;
create policy staff_gate_read on public.staff_gate_log for select to authenticated
  using (school_id = public.my_school() and public.is_staff());

drop policy if exists staff_gate_write on public.staff_gate_log;
create policy staff_gate_write on public.staff_gate_log for insert to authenticated
  with check (
    school_id = public.my_school()
    and public.my_role() in ('director','supervisor','reception')
  );

create trigger trg_staff_cards_stamp_school
before insert on public.staff_cards
for each row execute function public.stamp_school();

-- بيانات تجريبية أولية: بطاقات QR للطاقم الموجود، قابلة للإلغاء والتغيير.
insert into public.staff_cards (school_id, staff_id, card_no, method, active)
select school_id, id,
       'STAFF-' || lpad((row_number() over (partition by school_id order by created_at, id))::text, 4, '0'),
       'qr', true
from public.staff s
where not exists (
  select 1 from public.staff_cards sc
  where sc.school_id = s.school_id and sc.staff_id = s.id
)
  and (select count(*) from public.staff_cards sc where sc.school_id = s.school_id) = 0;

create trigger trg_staff_gate_stamp_school
before insert on public.staff_gate_log
for each row execute function public.stamp_school();

create trigger trg_staff_gate_stamp_author
before insert on public.staff_gate_log
for each row execute function public.stamp_author();
