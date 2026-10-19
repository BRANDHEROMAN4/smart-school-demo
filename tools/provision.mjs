#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — إنشاء حسابات الدخول (بطاقة + رمز سري)
 *  الملف: tools/provision.mjs
 *
 *  لماذا سكربت ولا SQL؟ لأن كتابة كلمات السر مباشرةً في جدول auth.users
 *  **ليست مدعومة رسميًا** في Supabase وقد تنكسر مع أي تحديث. الطريق الصحيح
 *  هو Admin API بمفتاح service_role — وهو ما يفعله هذا السكربت.
 *
 *  الاستعمال:
 *    export SUPABASE_URL="https://xxxx.supabase.co"
 *    export SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."
 *    node tools/provision.mjs                 # كل التلاميذ + طاقم تجريبي
 *    node tools/provision.mjs --dry           # عرض بلا إنشاء ولا كتابة
 *    node tools/provision.mjs --parent 0555123456   # وليّ واحد فقط
 *    node tools/provision.mjs --reset-pins    # رمز جديد لكل حساب قائم
 *                                             # (لإنقاذ رموز ضاعت بعد فشل كتابة الكشف)
 *
 *  ⚠️ مفتاح service_role **يتجاوز كل سياسات RLS**. لا تضعْه أبدًا في ملف
 *     HTML ولا في متغيّر يبدأ بـ VITE_/NEXT_PUBLIC_. استعمله على جهازك فقط.
 *
 *  المخرَج: roster.csv — كشف البطاقات والأرقام السرّية لتوزيعه على التلميذات
 *  وأولياء أمورهنّ (الوليّ يدخل برقم هاتفه لا ببطاقة).
 * ==========================================================================*/

import { writeFileSync, openSync, closeSync, existsSync } from "node:fs";

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DRY = process.argv.includes("--dry");
/* --reset-pins: الحساب قائم لكن رمزه غير معروف (ضاع لأن كتابة الكشف فشلت،
   أو لأن الكشف القديم حُذف) ⇒ يُضبط رمز جديد ويُطبع في الكشف. بدونه
   يُتجاهَل الحساب القائم ويُطبع «الرمز السابق هو النافذ» — وعدٌ باطل إن
   لم يكن أحد يعرف ذلك الرمز. */
const RESET = process.argv.includes("--reset-pins");
const PARENT_ARG = process.argv.indexOf("--parent");
const ONLY_PARENT = PARENT_ARG >= 0 ? canonPhone(process.argv[PARENT_ARG + 1] || "") : "";

/* الرمز السري: ٦ أرقام — طويل بما يكفي لسياسة Supabase الافتراضية، وقصير
   بما يكفي لتلميذة في الابتدائي. */
const PIN_LEN = 6;
const randomPin = () =>
  Array.from({ length: PIN_LEN }, () => Math.floor(Math.random() * 10)).join("");

/* رقم الهاتف — صيغةٌ واحدة لكل الكتابات.
   بلا توحيد: `0555123456` و`+213555123456` و`0555 12 34 56` تُنتج ثلاثة
   معرفاتٍ متمايزة ⇒ الأمّ تكتب رقمها بطريقتها فتُمنع من الدخول وحسابُها قائم.
   ويُطبَّق **عند الإنشاء وعند الدخول معًا**. نسخةٌ مطابقة في الملفّ الآخر،
   وحارسٌ ساكن في tests/static.test.js يقابلهما نصًّا كي لا تفترقا. */
function canonPhone(v){
  const raw=String(v==null?"":v).trim();
  let d=raw.replace(/\D/g,"");
  if(/^00213/.test(d)) d=d.slice(5);
  else if(/^213/.test(d)) d=d.slice(3);
  d=d.replace(/^0+/,"");
  if(!/^\d{9}$/.test(d)) return raw;   /* ليس جوّالًا ⇒ يُترك كما هو */
  return "0"+d;
}
/* "RF-0001" → "rf-0001@eduvia.local"  |  "0555123456" → "0555123456@eduvia.local"
   بريد اصطناعي لا يُرسَل إليه أبدًا، لكنه يسمح لـSupabase Auth أن يعمل
   بأصالته بلا مزوّد بريد. */
export const toEmail = (loginId) =>
  `${canonPhone(loginId).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@eduvia.local`;

/* رمزٌ يُطبع في الكشف. وحسابٌ **موجود سلفًا** يحتفظ برمزه القديم — فنقولها
   بدل طبع رقمٍ جديد لا يعمل، وإلّا وُزِّع رمزٌ كاذب على تلميذة. */
const PIN_COL = (created, pin) =>
  created ? pin : "— (حساب موجود · الرمز السابق هو النافذ)";

/* ------------------------------------------------------------------ HTTP */
async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* نصّ غير JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

/* ------------------------------------------------------- إنشاء مستخدم */
async function createUser(loginId, pin, meta) {
  const email = toEmail(loginId);
  const r = await api("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password: pin, email_confirm: true, user_metadata: meta },
  });
  if (r.ok) return { id: r.json.id, created: true };
  // موجود سلفًا ⇒ نجلبه بدل أن نفشل
  if (r.status === 422 || r.status === 409) {
    const list = await api(`/auth/v1/admin/users?page=1&per_page=1000`);
    if (list.ok && Array.isArray(list.json?.users)) {
      const found = list.json.users.find((u) => u.email === email);
      if (found) {
        if (RESET) {
          const u = await api(`/auth/v1/admin/users/${found.id}`, {
            method: "PUT",
            body: { password: pin },
          });
          if (!u.ok)
            throw new Error(`فشل تجديد رمز ${loginId}: ${u.status} ${u.text.slice(0, 160)}`);
          return { id: found.id, created: true };
        }
        return { id: found.id, created: false };
      }
    }
  }
  throw new Error(`فشل إنشاء ${email}: ${r.status} ${r.text.slice(0, 160)}`);
}

async function upsertProfile(row) {
  const r = await api("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: row,
  });
  if (!r.ok) throw new Error(`فشل حفظ الملفّ الشخصي ${row.login_id}: ${r.status} ${r.text.slice(0, 160)}`);
}

/* ---------------------------------------------------------------- البرنامج */
async function main() {
  if (!URL_BASE || !KEY) {
    console.error("✖ ينقص SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY.\n" +
                  "  راجِع SUPABASE-SETUP.md — الخطوة ٤.");
    process.exit(2);
  }
  if (PARENT_ARG >= 0 && !/^0\d{9}$/.test(ONLY_PARENT)) {
    console.error("✖ --parent يحتاج رقم جوّال صحيحًا، مثل: --parent 0555123456");
    process.exit(2);
  }
  /* كشفٌ قائم + تشغيلٌ بلا --reset-pins = طمسُ الرموز. الحسابات القائمة
     تُطبع «الرمز السابق هو النافذ»، والملفّ الذي يحمل ذلك الرمز هو نفسه الذي
     سنكتب فوقه. نرفض بدل أن نمحو أسرارًا لا بديل عنها. */
  if (!DRY && !RESET && existsSync("roster.csv")) {
    console.error("✖ roster.csv موجود — إعادة الكتابة عليه تمحو الرموز الحالية.\n" +
      "  انقل الكشف القديم أولًا (Move-Item roster.csv roster.old.csv)،\n" +
      "  أو استعمل --reset-pins لإصدار رموز جديدة لكل الحسابات.");
    process.exit(2);
  }
  /* فحص القفل **قبل** أي كتابة على الخادم. العطل الذي وقع فعلًا: كل الحسابات
     تُنشأ، ثم تفشل كتابة الكشف في آخر السكربت (EBUSY لأن الملفّ مفتوح في
     Excel) ⇒ الحسابات قائمة ورمزُها لا يعرفه أحد، والكشف المعروض قديمٌ أو
     وهميّ. الفشل هنا رخيص؛ هناك لا رجعة له. */
  if (!DRY) {
    try { closeSync(openSync("roster.csv", "a")); }
    catch (e) {
      console.error(`\x1b[31m✖ لا يمكن الكتابة في roster.csv (${e.code}).\x1b[0m\n` +
        "  أغلقْه في Excel / أي برنامج ثم أعد التشغيل — لم يُنشأ شيء بعد.");
      process.exit(2);
    }
  }
  console.log(`\n\x1b[1mEDUVIA — إنشاء الحسابات\x1b[0m  ${DRY ? "\x1b[33m[عرض فقط]\x1b[0m" : ""}\n`);

  // المؤسسة
  const schools = await api("/rest/v1/schools?select=id,name&limit=1");
  if (!schools.ok || !schools.json?.length) {
    console.error("✖ لا توجد مؤسسة. شغّل sql/001 ثم sql/003 في محرّر SQL أولًا.");
    process.exit(1);
  }
  const school = schools.json[0];
  console.log(`▸ المؤسسة: ${school.name}`);

  // التلاميذ
  /* ⚠️ parent_phone وparent_name **لازمان** هنا: حلقة الأولياء أدناه تُجمّع
     بالهاتف، وبلا جلبه يصبح undefined ⇒ canonPhone تُعيد "" ⇒ تُتخطّى كل
     تلميذة بصمت ولا يُنشأ حساب وليّ واحد. وparent_name اسم الوليّ كما
     أدخلته المدرسة، لا «وليّ <اسم التلميذة>» المُختلَق. */
  const st = await api("/rest/v1/students?select=id,card_no,full_name,class_label,parent_name,parent_phone&order=card_no");
  if (!st.ok) throw new Error(`فشل قراءة التلاميذ: ${st.text.slice(0, 160)}`);
  const students = st.json || [];
  console.log(`▸ التلاميذ: ${students.length}`);

  /* العمود الرابع ليس «قسمًا» لسطر الوليّ بل أبناءه: اسمٌ وقسم. تسميته صراحةً
     تمنع قراءةً خاطئة كـ«البيانات غير مرتّبة» — فهي في أعمدتها الصحيحة. */
  const roster = [["نوع الحساب", "مُعرِّف الدخول", "الاسم", "القسم / الأبناء", "الرمز السري"]];
  let made = 0, reused = 0;

  /* ---------------------------------------------- حسابات التلاميذ */
  for (const s of students) {
    const pin = randomPin();
    try {
      const { id, created } = DRY
        ? { id: "00000000-0000-0000-0000-000000000000", created: true }
        : await createUser(s.card_no, pin, { role: "student", name: s.full_name });
      created ? made++ : reused++;
      if (!DRY) {
        await upsertProfile({
          id, school_id: school.id, role: "student",
          display_name: s.full_name, login_id: s.card_no, student_id: s.id,
        });
      }
      roster.push(["تلميذة", s.card_no, s.full_name, s.class_label, PIN_COL(created, pin)]);
    } catch (e) {
      console.error(`  ✗ ${s.card_no} — ${e.message}`);
    }
  }

  /* ---------------------------------------------- حسابات الطواقم */
  const staffAccounts = [
    ["director",   "المديرة زهية",          "director"],
    ["supervisor", "الناظر كريم",            "supervisor"],
    ["reception",  "الأمانة",               "reception"],
    ["RF-T001",    "الأستاذة فاطمة الزهراء", "teacher"],
    ["inspector",  "المفتّش سعيد",           "inspector"],
    ["authority",  "مديرية التربية",         "authority"],
  ];
  for (const [loginId, name, role] of staffAccounts) {
    const pin = randomPin();
    try {
      const { id, created } = DRY
        ? { id: "00000000-0000-0000-0000-000000000000", created: true }
        : await createUser(loginId, pin, { role, name });
      created ? made++ : reused++;
      if (!DRY) {
        await upsertProfile({
          id, school_id: school.id, role,
          display_name: name, login_id: loginId,
        });
      }
      roster.push(["طاقم", loginId, name, role, PIN_COL(created, pin)]);
    } catch (e) {
      console.error(`  ✗ ${loginId} — ${e.message}`);
    }
  }

  /* ---------------------------------------------- حسابات الأولياء
     مُعرِّف الدخول **رقم الهاتف** (لا بطاقة لهم)، والربط بابنتهم في جدول
     `guardians` — و`profiles.student_id` تبقى فارغة للوليّ (تلك للتلميذة
     وحدها، والوليّ قد يكون له أكثر من ابنة).
     ويُجمَّع بالهاتف **الموحَّد**: أمٌّ لها ابنتان ⇒ حسابٌ واحد ورمزٌ واحد
     وصفّان في `guardians` — وهذا سبب وجود جدول الوصل لا عمودٍ في التلميذة. */
  const byPhone = new Map();
  for (const s of students) {
    const phone = canonPhone(s.parent_phone);
    if (!/^0\d{9}$/.test(phone)) continue;   /* بلا رقم جوّال صحيح لا حساب */
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, children: [] });
    byPhone.get(phone).children.push(s);
  }
  const skipped = students.length
    ? [...new Set(students.map(s => canonPhone(s.parent_phone)))]
        .filter(p => !/^0\d{9}$/.test(p)).length
    : 0;
  const parentList = [...byPhone.values()].filter(
    (p) => !ONLY_PARENT || p.phone === ONLY_PARENT
  );
  if (PARENT_ARG >= 0 && parentList.length === 0) {
    console.error(`✖ لا تلميذة مرتبطة بالرقم ${ONLY_PARENT} في parent_phone.`);
    process.exit(1);
  }
  console.log(`▸ الأولياء (أرقام جوّال مميّزة): ${byPhone.size}` +
    (skipped ? ` · \x1b[33m${skipped} رقمًا غير صالح تُخطّي\x1b[0m` : "") +
    (ONLY_PARENT ? ` · \x1b[33mوليّ واحد فقط: ${ONLY_PARENT}\x1b[0m` : ""));

  for (const { phone, children } of parentList) {
    const pin = randomPin();
    const who = children[0].parent_name || ("وليّ " + children[0].full_name);
    try {
      const { id, created } = DRY
        ? { id: "00000000-0000-0000-0000-000000000000", created: true }
        : await createUser(phone, pin, { role: "parent", name: who });
      created ? made++ : reused++;
      if (!DRY) {
        await upsertProfile({
          id, school_id: school.id, role: "parent",
          display_name: who, login_id: phone,
          /* student_id تبقى null: الربط في guardians لا في الملفّ. */
        });
        for (const c of children) {
          const r = await api("/rest/v1/guardians?on_conflict=profile_id,student_id", {
            method: "POST",
            headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
            body: { profile_id: id, student_id: c.id, relation: "parent" },
          });
          if (!r.ok)
            throw new Error(`فشل ربط ${phone} بـ${c.card_no}: ${r.status} ${r.text.slice(0, 120)}`);
        }
      }
      roster.push(["وليّ أمر", phone, who,
                   "الأبناء: " + children.map((c) => c.full_name + " (" + c.class_label + ")").join(" · "),
                   PIN_COL(created, pin)]);
    } catch (e) {
      console.error(`  ✗ ${phone} — ${e.message}`);
    }
  }

  /* ---------------------------------------------- كشف البطاقات
     ⚠️ لا يُكتب في وضع --dry: كان يكتب كشفًا بأرقام وهمية فوق الكشف الحقيقي،
     فيضيع رمز التوزيع بمجرّد «معاينة».
     وإن كان الملفّ مفتوحًا في Excel (EBUSY) نكتب نسخة إنقاذ بدلًا منه:
     الرموز وُلِّدت الآن ولا تُخزَّن في أي مكان آخر — ضياعها يعني حسابات
     قائمة برمزٍ لا يعرفه أحد. */
  const csv = "﻿" + roster.map((r) => r.map((c) => `"${c}"`).join(",")).join("\r\n");
  if (DRY) {
    console.log("\n✔ عرض فقط: لم تُنشأ حسابات ولم تُكتب roster.csv.");
  } else {
    try {
      writeFileSync("roster.csv", csv, "utf8");
      console.log("✔ الكشف في roster.csv — \x1b[33mوزّعه ثم احذفه\x1b[0m");
    } catch (e) {
      console.error(`\n\x1b[31m⚠️ تعذّر كتابة roster.csv (${e.code}) — غالبًا مفتوح في Excel. أغلقْه.\x1b[0m`);
      try {
        writeFileSync("roster.rescue.csv", csv, "utf8");
        console.error("\x1b[33m   حفظتُ الرموز في roster.rescue.csv — انقله إلى مكان آمن واحذفه بعد الطبع.\x1b[0m");
      } catch {
        console.error("\x1b[31m   انسخ هذا الكشف الآن قبل إغلاق النافذة:\x1b[0m\n" + csv);
      }
    }
  }

  console.log(`\n✔ ${DRY ? "معاينة: " : ""}${made} حسابًا ${DRY ? "سيُنشأ" : "أُنشئ/جُدِّد"} · أُعيد استخدام ${reused}`);
  console.log(`\nملاحظة: الأرقام السرّية مُولَّدة عشوائيًا ولا تُخزَّن عندنا.
احتفظ بـroster.csv في مكان آمن ثم احذفه بعد طبع البطاقات.\n`);
}

main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
