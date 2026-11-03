-- الحفظ المرحلي للرمز الحالي ضروري كي تظهره المديرة مخفيًا ويمكن كشفه بالعين.
-- الوصول محصور بالمديرة عبر سياسة RLS الموجودة على الجدول؛ لا تُمنح الخدمة لأي دور آخر.

alter table public.parent_credential_issuances
  add column if not exists current_pin text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'parent_credential_current_pin_format'
  ) then
    alter table public.parent_credential_issuances
      add constraint parent_credential_current_pin_format
      check (current_pin is null or current_pin ~ '^\d{6}$');
  end if;
end
$$;
