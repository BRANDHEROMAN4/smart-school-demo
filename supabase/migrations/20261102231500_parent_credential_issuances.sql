-- سجل إصدار رموز أولياء الأمر: لا يخزن رمزًا سريًا نصيًا.
-- رمز الدخول الجديد يظهر للمديرة عند الإصدار فقط ويُجدد عبر الدالة الآمنة.

create table if not exists public.parent_credential_issuances (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete set null,
  login_id text not null,
  display_name text not null,
  action text not null default 'issued',
  issued_by uuid not null,
  issued_at timestamptz not null default now(),
  unique (school_id, login_id, issued_at)
);

create index if not exists parent_credential_issuances_school_idx
  on public.parent_credential_issuances(school_id, issued_at desc);

alter table public.parent_credential_issuances enable row level security;

create policy parent_credentials_director_select
on public.parent_credential_issuances for select
using (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'director'
      and p.school_id = parent_credential_issuances.school_id
  )
);

create policy parent_credentials_director_insert
on public.parent_credential_issuances for insert
with check (
  exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'director'
      and p.school_id = parent_credential_issuances.school_id
  )
);
