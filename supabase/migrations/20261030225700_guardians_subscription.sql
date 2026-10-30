-- ============================================================================
--  EDUVIA — سجلّ اشتراك أولياء الأمور
--  الملف: sql/007_guardians_subscription.sql
--
--  ⚠️ يُشغَّل **يدويًّا** في Supabase SQL Editor. آمن للإعادة (if not exists).
--     (لا أملك service_role ولا أطلبه — التنفيذ من عندك.)
--
--  لماذا جدولٌ ولا عمود؟ لأنّ **الرمز السرّي للوليّ يُسلَّم بعد الدفع** (قرار
--  المُشغِّل): فلا حسابَ لوليّ قبل الدفع، ويقع تسليم الرمز عند التسليم لا عند
--  التشغيل. ⇒ **لا حجبَ وقت التشغيل إطلاقًا**، ودور هذا الجدول التجديد
--  والمحاسبة. وهذا مقصود: إخفاء غياب طفلة عن أمّها يضرّ الطفل لا الأمّ.
--
--  ⚠️ «رقم الهاتف» في `profiles.login_id` يُخزَّن **موحَّدًا** بصيغة `0555123456`
--     (تُوحّده `canonPhone` في provision.mjs وindex.html معًا). لا تُدخله يدويًّا
--     بصيغة أخرى وإلّا لم تستطع الأمّ الدخول.
-- ============================================================================


create table if not exists guardians_subscription (
  profile_id  uuid primary key references profiles(id) on delete cascade,
  paid_until  date not null,
  amount_dzd  integer check (amount_dzd is null or amount_dzd >= 0),
  receipt_no  text,
  recorded_by uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table guardians_subscription enable row level security;

-- ------------------------------------------------------------------ القراءة
-- الوليّ يقرأ سجلّه وحده؛ والطاقم الإداريّ يقرأ سجلات أولياء مؤسسته.
drop policy if exists gsub_read on guardians_subscription;
create policy gsub_read on guardians_subscription for select to authenticated
  using (
    profile_id = auth.uid()
    or (
      my_role() in ('director','supervisor','reception')
      and exists (
        select 1 from profiles p
        where p.id = guardians_subscription.profile_id
          and p.school_id = my_school()
      )
    )
  );

-- ------------------------------------------------------------------ الكتابة
-- المدير والأمانة وحدهما: تسلّم المال ليس عمل معلّمة، وتسجيل الاشتراك ليس
-- عمل وليّ الأمر نفسه (وإلّا مدّد اشتراكه بضغطة).
drop policy if exists gsub_write on guardians_subscription;
create policy gsub_write on guardians_subscription for all to authenticated
  using (my_role() in ('director','reception'))
  with check (
    my_role() in ('director','reception')
    and exists (
      select 1 from profiles p
      where p.id = guardians_subscription.profile_id
        and p.school_id = my_school()
        and p.role = 'parent'          -- ولا يُكتب سجلٌّ لحساب تلميذة أو طاقم
    )
  );


-- ============================================================================
--  تسجيل دفعة (مثال — انسخه وعدّله؛ لا يُنفَّذ تلقائيًّا)
--
--  بعد تسليم البطاقة نقدًا، سجّل الدفعة ليعرف التطبيقُ حتى متى هي سارية.
--  المفتاح هو **رقم هاتف الوليّ الموحَّد** كما في roster.csv:
--
--  insert into guardians_subscription (profile_id, paid_until, amount_dzd, receipt_no)
--  select id, date '2027-06-30', 3000, 'وصل-001'
--  from profiles
--  where login_id = '0551234567' and role = 'parent'
--  on conflict (profile_id) do update
--    set paid_until = excluded.paid_until,
--        amount_dzd = excluded.amount_dzd,
--        receipt_no = excluded.receipt_no,
--        updated_at = now();
--
--  ولعرض ما سُجِّل:
--  select p.login_id, p.display_name, s.paid_until, s.amount_dzd, s.receipt_no
--  from guardians_subscription s join profiles p on p.id = s.profile_id
--  order by s.paid_until;
--
--  ⚠️ تذكير: `roster.csv` يحمل الرموز السرّية للأولياء أيضًا — احذفه بعد
--     التوزيع. وردمُ: شاشةٌ للأمانة تُسجّل الدفعة من داخل التطبيق تأتي في
--     الدفعة القادمة؛ الآن السطر أعلاه يكفي لتجربةٍ من عشرات الأولياء.
-- ============================================================================
