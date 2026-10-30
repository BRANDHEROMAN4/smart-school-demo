-- ============================================================================
--  EDUVIA — طريقة تسجيل العبور
--  الملف: sql/008_gate_method.sql        (يُنفَّذ يدويًّا في SQL Editor)
--
--  لماذا؟ كان `gate_log` يحفظ التلميذة والوقت والتأخّر فقط. فالكاميرا والرقم
--  المكتوب و«تحضير» المعلّمة تكتب الصفّ نفسه، فلا تُعرَف لاحقًا **كيف** عبَرت
--  التلميذة. وهذا العمود يحفظ المصدر مع كلّ عبور من الآن فصاعدًا.
--
--  القيم: qr (كاميرا) · manual (رقم كتبته الأمانة) · teacher (تحضير يدوي)
--         simulated (محاكاة العرض التجريبي) · legacy (صفوف سبقت هذا العمود —
--         لا نزعم معرفة ما لم يُحفظ).
--
--  بلا هذا الملفّ يعمل التطبيق كما هو: لا يُرسل العميل `method` قبل أن يثبت
--  وجوده (العمود المجهول يردّه PostgREST فيتوقّف الطابور كلّه)، ويعرض
--  «غير مسجَّل» بصدق.
-- ============================================================================

alter table public.gate_log
  add column if not exists method text not null default 'legacy';

-- القيد في خطوة منفصلة كي يبقى الملفّ قابلًا لإعادة التنفيذ بلا خطأ.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.gate_log'::regclass
      and conname  = 'gate_log_method_chk'
  ) then
    alter table public.gate_log add constraint gate_log_method_chk
      check (method in ('qr','manual','teacher','simulated','legacy'));
  end if;
end $$;

comment on column public.gate_log.method is
  'طريقة العبور: qr كاميرا · manual رقم مكتوب · teacher تحضير يدوي · simulated محاكاة · legacy صفّ سبق العمود';
