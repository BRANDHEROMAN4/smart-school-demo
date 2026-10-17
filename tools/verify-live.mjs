#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — إثبات حيّ: هل الجلب (hydration) يعمل فعلًا على الخادم؟
 *  الملف: tools/verify-live.mjs
 *
 *  يجيب سؤالًا واحدًا: **ماذا ترى كل مستخدمة عند دخولها؟**
 *  يُحاكي ما تفعله hydrate() بالضبط: نفس الجداول، نفس الأعمدة، نفس الأدوار.
 *  الاختبارات المحلية تشغّل hydrate() بخادم وهمي؛ هذا يتحقّق من **الخادم نفسه**:
 *  مشروع Supabase حقيقي، RLS حقيقية، بيانات حقيقية.
 *
 *  الاستعمال:
 *    node tools/verify-live.mjs            # يقرأ الإعداد من index.html و roster.csv
 *    node tools/verify-live.mjs --keep     # لا يُعيد الملاحظات إلى حالتها
 *
 *  ⚠️ يعدّل بيانات المدرسة التجريبية (اعتراض ثم إلغاء ثم إعادة). بلا --keep
 *     يعيدها كما كانت في النهاية. شغّله على مشروع تجريبي لأنّ هذا مقصوده.
 *
 *  الأرقام السرّية تُقرأ من roster.csv (مُستثنى من Git) — لا تُكتب في الكود.
 * ==========================================================================*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");

/* ------------------------------------------------ الإعداد من index.html */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const grab = (k) => {
  const m = new RegExp(`${k}\\s*:\\s*"([^"]+)"`).exec(html);
  return m ? m[1] : null;
};
const URL_ = grab("supabaseUrl");
const KEY = grab("supabaseAnonKey");
if (!URL_ || !KEY) {
  console.error("✖ لم أجد supabaseUrl/supabaseAnonKey في EDUVIA_CONFIG داخل index.html.");
  console.error("  المنصّة في الوضع المحلي — لا خادم لتُختبر عليه.");
  process.exit(2);
}

/* ------------------------------------------------ الكشف (roster.csv) */
const ROSTER = path.join(ROOT, "roster.csv");
if (!fs.existsSync(ROSTER)) {
  console.error("✖ لا يوجد roster.csv — شغّل أولًا: node tools/provision.mjs");
  console.error("  (الملف مُستثنى من Git لأنّه يحمل الأرقام السرّية.)");
  process.exit(2);
}
/* الأسطر: "النوع","المُعرِّف","الاسم","القسم","الرمز السري" (BOM في أوله) */
const rows = fs.readFileSync(ROSTER, "utf8").replace(/^﻿/, "")
  .split(/\r?\n/).slice(1).filter((l) => l.trim())
  .map((l) => (l.match(/"[^"]*"/g) || []).map((c) => c.slice(1, -1)))
  .filter((c) => c.length >= 5);

const student = rows.find((c) => c[0] === "تلميذة");
const student2 = rows.filter((c) => c[0] === "تلميذة" && c[1] !== student?.[1])[0] || null;
const director = rows.find((c) => c[1] === "director");
const teacher = rows.find((c) => c[0] === "طاقم" && c[3] === "teacher");
if (!student || !director) {
  console.error("✖ لم أجد تلميذة ومديرًا في roster.csv — أعد تشغيل provision.mjs.");
  process.exit(2);
}

/* ------------------------------------------------ الإحصاء */
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, m, d) => (c ? ok(m) : no(m, d));

const H = (t) => ({ apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function login(id, pin) {
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${id.toLowerCase()}@eduvia.local`, password: pin }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${id}: ${j.error_description || j.msg || r.status}`);
  return j.access_token;
}
const get = async (t, q, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}?${q}`, { headers: H(tok) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const patch = async (t, q, row, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}?${q}`, {
    method: "PATCH", headers: { ...H(tok), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = async (t, row, tok) => {
  const r = await fetch(`${URL_}/rest/v1/${t}`, {
    method: "POST", headers: { ...H(tok), Prefer: "return=representation" },
    body: JSON.stringify(row),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/* مُعرِّف الحساب (auth.uid) — القاعدة تشترط created_by، والعميل يرسله من جلسته. */
const whoami = async (tok) => {
  const r = await fetch(`${URL_}/auth/v1/user`, { headers: H(tok) });
  const j = await r.json().catch(() => null);
  return j ? j.id : null;
};

/* ============================================================ التشغيل */
(async () => {
  console.log("\n\x1b[1mEDUVIA — إثبات الجلب على الخادم الحقيقي\x1b[0m");
  console.log(`\x1b[2m${URL_}  ·  ${student[1]} و ${director[1]}\x1b[0m\n`);

  const stu = await login(student[1], student[4]);
  const dir = await login(director[1], director[4]);
  const tea = teacher ? await login(teacher[1], teacher[4]) : null;
  /* الأمانة: هي التي تقف على الباب — ولها `gate_write` وحدها دون `can_record`. */
  const recepRow = rows.find((c) => c[1] === "reception");
  const recep = recepRow ? await login(recepRow[1], recepRow[4]) : null;
  ok(`دخول ${student[1]} و${director[1]}${teacher ? " و" + teacher[1] : ""}${recepRow ? " و" + recepRow[1] : ""} — كلّهم نالوا جلسة`);

  /* اختبار سابق قد يترك اعتراضًا معلّقًا. نبدأ من حالة نظيفة، وإلّا قاس
     الإثباتُ أثرًا قديمًا لا سلوكًا حاليًّا. */
  if (!KEEP) {
    const r = await patch("behaviour_notes", "id=not.is.null",
      { status: "open", reply: null, replied_at: null }, dir);
    ok(`أُعيدت الملاحظات التجريبية إلى حالتها الأصلية (${(r.body || []).length} صفّ)`);
  }

  /* ---------- ① ما يراه كل دور: جوهر «المدرسة موجودة» ---------- */
  console.log("\n▸ ① عدد الصفوف المرئية — RLS هي المرشّح لا الواجهة");
  const s1 = await get("students",
    "select=id,card_no,full_name,class_label,parent_name,parent_phone,notify_pref,grade,section", stu);
  const s2 = await get("students", "select=id,card_no,full_name", dir);
  chk(s1.status === 200 && s1.body.length === 1, "التلميذة ترى صفًّا واحدًا فقط",
      JSON.stringify(s1.body).slice(0, 120));
  chk(s1.body[0]?.card_no === student[1], "وهو صفّها هي");
  chk(s2.status === 200 && s2.body.length > 1, `المديرة ترى المدرسة كاملة (${s2.body.length})`,
      "رأت " + s2.body.length);
  chk(s1.body[0] && "parent_name" in s1.body[0] && "notify_pref" in s1.body[0],
      "كل الأعمدة التي تحتاجها الواجهة حاضرة (الوليّ · الهاتف · التفضيل)");

  /* ---------- ② سجلّ السلوك ---------- */
  console.log("\n▸ ② سجلّ السلوك — الحالة تُشتقّ من reply لا تُخمَّن");
  const n1 = await get("behaviour_notes",
    "select=id,student_id,category,kind,body,subject,noted_on,author_name,reply,replied_at,status,client_id&order=noted_on.desc", stu);
  chk(n1.status === 200 && n1.body.length >= 1, `التلميذة ترى ملاحظاتها (${(n1.body || []).length})`);
  /* ملاحظةٌ «قائمة» بلا اعتراض **وفي مهلة الاعتراض**: الشرطان الأولان لا
     يكفيان. `guard_note_update` على الخادم يردّ اعتراضًا على ملاحظة أقدم من
     BEHAV_REPLY_DAYS (٧ أيام) بـ42501 ⇒ فاختيار ملاحظةٍ قديمة يُسقط ثلاث
     تأكيدات **بلا أن يتغيّر سطرٌ في الكود**. ووقع فعلًا: خضراء في 2026-10-13،
     وثلاثة إخفاقات في 2026-10-16 — لأنّ العمر مرّ لا لأنّ شيئًا انكسر.
     (ولا تُزرع ملاحظة جديدة: `behaviour_notes` بلا سياسة حذف ⇒ تبقى أبدًا.) */
  const REPLY_DAYS = 7;                    /* ≡ BEHAV_REPLY_DAYS و guard_note_update */
  const inWindow = (n) =>
    (Date.now() - new Date(n.noted_on + "T00:00:00Z").getTime()) <= REPLY_DAYS * 864e5;
  const open = (n1.body || []).find((n) => n.status === "open" && !n.reply && inWindow(n));
  const nd = await get("behaviour_notes", "select=id&limit=1000", dir);
  chk(nd.body.length >= 8, `المديرة ترى ملاحظات المدرسة (${nd.body.length})`);
  /* وهذا ليس تأكيدًا على الكود بل على **حالة البيانات**: هل بَقِيت ملاحظةٌ
     داخل المهلة؟ فحين تنقضي المهلة كلّها يصير «فشلًا» أبديًّا في حزمةٍ سليمة
     — وهو أسوأ من التخطّي المُعلَن: يُدرّب على تجاهل الأحمر. */
  if (open) {
    ok("توجد ملاحظة «قائم» بلا اعتراض وفي مهلة الردّ ⇒ تُعرض «قائم» لا «قيد النظر»");
  } else {
    console.log("\n\x1b[33m⚠️ لا ملاحظة قائمة داخل مهلة الاعتراض — تُخطّى ④ و⑥ (المسار مغطّى محليًّا في rls.test.js).\x1b[0m");
  }

  /* ---------- ③ النقاط والحضور ---------- */
  console.log("\n▸ ③ النقاط والحضور — ما يُبنى منه دفتر النقاط");
  const g = await get("grades", "select=id,student_id,subject,label,kind,mark", stu);
  chk(g.status === 200 && g.body.length >= 1, `نقاط التلميذة تصل (${g.body.length})`);
  chk(g.body.every((x) => ["summative", "formative"].includes(x.kind)),
      "كل صفّ يحمل نوعه (summative/formative)");
  const a = await get("attendance", "select=student_id,day,state,at_time", stu);
  chk(a.status === 200 && a.body.length >= 1, `سجلّ الحضور يصل (${a.body.length})`);

  /* ---------- ④ الاعتراض: تعديل الصفّ نفسه ---------- */
  if (open) {
    console.log("\n▸ ④ الاعتراض — تعديل الصفّ نفسه لا إنشاء نسخة ثانية");
    const before = n1.body.length;
    const TEXT = "إثبات آلي: هذا اعتراض";
    const obj = await patch("behaviour_notes", "id=eq." + open.id,
      { reply: TEXT, replied_at: new Date().toISOString() }, stu);
    chk(obj.status === 200 && Array.isArray(obj.body) && obj.body.length === 1,
        "التلميذة كتبت اعتراضها ⇒ صفّ واحد تأثّر",
        `HTTP ${obj.status} · ${JSON.stringify(obj.body).slice(0, 140)}`);
    const after = await get("behaviour_notes", "select=id", stu);
    chk(after.body.length === before, "عدد الملاحظات لم يزد ⇒ لم تُنشأ نسخة ثانية");

    /* جوهر الشكوى المُبلَّغ عنها: هل يُدرَج الاعتراض في قائمة المديرة؟
       هذا **نفس الاستعلام** الذي يبنيه الآن قسم «اعتراضات على ملاحظات السلوك». */
    const objs = await get("behaviour_notes", "select=id&status=eq.open&reply=not.is.null", dir);
    chk((objs.body || []).some((x) => x.id === open.id),
        "الاعتراض يظهر في قائمة المديرة («قيد النظر») — وهو ما كان يبدو مفقودًا",
        JSON.stringify(objs.body).slice(0, 120));

    /* ---------- ⑤ الحدّ: لا تمسّ الحالة ---------- */
    console.log("\n▸ ⑤ الحدّ — التلميذة لا تمسّ الحالة");
    const bad = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, stu);
    chk(bad.status >= 400, "محاولة إلغاء ملاحظة على نفسها ⇒ مرفوضة",
        `HTTP ${bad.status} · ${JSON.stringify(bad.body).slice(0, 120)}`);
    if (tea) {
      const tbad = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, tea);
      chk(tbad.status >= 400 || (tbad.body || []).length === 0,
          "المعلّمة كذلك لا تُلغي (الحالة للمديرة وحدها)");
    }

    /* ---------- ⑥ المديرة تحسم ---------- */
    console.log("\n▸ ⑥ المديرة ترى الاعتراض وتحسمه");
    const seen = await get("behaviour_notes", "select=id,reply&id=eq." + open.id, dir);
    chk(seen.body[0]?.reply === TEXT, "المديرة ترى نصّ الاعتراض");
    const rev = await patch("behaviour_notes", "id=eq." + open.id, { status: "revoked" }, dir);
    chk(rev.status === 200 && rev.body.length === 1, "المديرة ألغت الملاحظة ⇒ صفّ واحد");

    /* ---------- ⑦ إعادة الحالة ---------- */
    if (!KEEP) {
      const back = await patch("behaviour_notes", "id=eq." + open.id,
        { status: "open", reply: null, replied_at: null }, dir);
      chk(back.status === 200 && back.body.length === 1,
          "أُعيدت الملاحظة إلى حالتها الأصلية (البيانات التجريبية نظيفة)");
    }
  }

  /* ---------- ⑧ الطابور: كتابة جديدة تصل فعلًا ---------- */
  console.log("\n▸ ⑧ الكتابة من الطابور — نفس ما يفعله flushQueue بـupsert");
  const cid = "verify-" + Date.now().toString(36);
  const ins = await fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST", headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify({ action: "إثبات آلي", target: "tools/verify-live.mjs", detail: cid, client_id: cid }),
  });
  const insBody = await ins.json().catch(() => null);
  chk(ins.status === 201 && insBody?.length === 1, "أثر جديد وصل سجلّ التدقيق");
  chk(insBody?.[0]?.actor_id != null, "الخادم وسم الفاعل بنفسه (لا يرسله العميل)");
  /* إعادة الإرسال نفسه: الفهرس الفريد على client_id ⇒ ازدواج 409 لا صفّ ثانٍ. */
  const dup = await fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST", headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify({ action: "إثبات آلي", target: "tools/verify-live.mjs", detail: cid, client_id: cid }),
  });
  chk(dup.status === 409 || dup.status === 400,
      "إعادة إرسال الصفّ نفسه ⇒ يرفضه الخادم (منع الازدواج يعمل)",
      "HTTP " + dup.status);
  if (!KEEP) {
    await fetch(`${URL_}/rest/v1/audit_log?client_id=eq.${encodeURIComponent(cid)}`,
      { method: "DELETE", headers: H(dir) });
  }

  /* ---------- ⑨ صندوق الشكاوى: كان لا يغادر الجهاز أبدًا ----------
     · بطريقة العميل نفسها: upsert بـclient_id وignoreDuplicates — لا إدراجًا
       آخر. فلا نقيس مسارًا غير الذي نُسلّمه.
     · وبمفتاح **ثابت**: كل تشغيل يُحدّث الصفّ نفسه بدل أن يترك شكوى جديدة في
       صندوق المديرة. (والتلميذة لا تملك تعديل شكواها، فـDO NOTHING هو الصحيح.) */
  console.log("\n▸ ⑨ صندوق الشكاوى — صفٌّ كما يبنيه rowFor بالضبط");
  const MARK = "eduvia-verify-marker";
  const stuUid = await whoami(stu);
  const cbody = "أثر إثبات آلي — يمكن حذفه من Table Editor ← complaints";
  const sendC = () => fetch(`${URL_}/rest/v1/complaints?on_conflict=client_id`, {
    method: "POST",
    headers: { ...H(stu), Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify({ kind: "شكوى", body: cbody, status: "مُرسَل",
                           created_by: stuUid, client_id: MARK }),
  });
  const c1 = await sendC();
  chk(c1.status === 201 || c1.status === 200,
      "التلميذة أرسلت شكوى بالطريقة التي ينفّذها الطابور ⇒ وصلت القاعدة",
      `HTTP ${c1.status} · ${(await c1.text()).slice(0, 120)}`);

  const row = await get("complaints", "select=id,status,created_by&client_id=eq." + MARK, stu);
  const rowId = row.body?.[0]?.id;
  chk(row.body?.length === 1, "وصفّ واحد فقط بالمفتاح الثابت (لا تتراكم آثار الاختبار)");
  chk(row.body?.[0]?.created_by === stuUid, "الخادم يربطها بصاحبتها (created_by)");

  const againC = await sendC();
  chk(againC.status === 201 || againC.status === 200,
      "وإعادة الإرسال تمرّ بهدوء (التلميذة لا تُعدّل شكواها — DO NOTHING)",
      "HTTP " + againC.status);

  const cDir = await get("complaints", "select=id&client_id=eq." + MARK, dir);
  chk(cDir.body?.length === 1, "المديرة ترى الشكوى — وهذا كان مستحيلًا قبل اليوم");
  if (student2) {
    const stu2 = await login(student2[1], student2[4]);
    const cS2 = await get("complaints", "select=id&client_id=eq." + MARK, stu2);
    chk(cS2.body?.length === 0, "والتلميذة الأخرى لا ترى شكوى زميلتها");
  }
  const cUp = await patch("complaints", "id=eq." + rowId, { status: "تمّت المعالجة" }, dir);
  chk(cUp.status === 200 && cUp.body?.length === 1, "المديرة حدّثت حالة الطلب ⇒ صفّ واحد");
  if (rowId) {
    const seen = await get("complaints", "select=status&id=eq." + rowId, stu);
    chk(seen.body?.[0]?.status === "تمّت المعالجة",
        "والتلميذة ترى قرار الإدارة (كانت ترى «مُرسَل» أبدًا)");
  }
  /* الصفّ يبقى موسومًا («أثر إثبات آلي») لأنّ **لا سياسة DELETE للشكاوى** —
     وهذا مقصود: صندوق شكاوى يستطيع المشتكى منه محوه ليس صندوق شكاوى.
     والمفتاح الثابت يضمن أنّه صفٌّ واحد أبدًا، لا واحدٌ في كل تشغيل. */

  /* ---------- ⑩ الطابور: على الطريقة التي ينفّذها flushQueue فعلًا ----------
     كل الإثباتات أعلاه تستعمل إدراجًا عاديًّا. وهذا بالضبط ما جعل العطل
     خفيًّا: العميل لا يُدرج، بل **upsert بمفتاح client_id**، وكان يفشل بـ42P10
     لأن الفهرس الفريد جزئيّ — فلا تُزامَن ولا عملية واحدة. نقيس ما يفعله هو. */
  console.log("\n▸ ⑩ مسار الكتابة الحقيقي — upsert بمفتاح client_id");
  const qid = "vq-" + Date.now().toString(36);
  const qrow = { action: "إثبات مسار الطابور", target: "verify-live", detail: qid, client_id: qid };
  const upsertAudit = () => fetch(`${URL_}/rest/v1/audit_log?on_conflict=client_id`, {
    method: "POST",
    headers: { ...H(dir), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(qrow),
  });
  const insAudit = () => fetch(`${URL_}/rest/v1/audit_log`, {
    method: "POST",
    headers: { ...H(dir), Prefer: "return=representation" },
    body: JSON.stringify(qrow),
  });

  const up1 = await upsertAudit();
  const up1Body = await up1.json().catch(() => null);
  const isOnConflict = up1.status >= 400 && /42P10|on conflict/i.test(JSON.stringify(up1Body));

  if (!isOnConflict) {
    chk(up1.status === 201 && up1Body?.length === 1,
        "upsert بمفتاح client_id يعمل ⇒ المزامنة تصل فعلًا",
        `HTTP ${up1.status} · ${JSON.stringify(up1Body).slice(0, 140)}`);

    /* audit_log **إضافة-فقط** (لا سياسة UPDATE). ومع الفهرس الكامل تصير إعادة
       الإرسال `ON CONFLICT DO UPDATE` ⇒ 42501. فنقيس الحالتين معًا: ما يفعله
       العميل الآن (ignoreDuplicates) — وما كان سيحدث لو أرسل merge. */
    const again = await fetch(`${URL_}/rest/v1/audit_log?on_conflict=client_id`, {
      method: "POST",
      headers: { ...H(dir), Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify(qrow),
    });
    const againText = (await again.text().catch(() => "")).slice(0, 120);
    chk(again.status === 201 || again.status === 200,
        "وإعادة إرسال الأثر نفسه تمرّ بهدوء (DO NOTHING — ما يفعله العميل)",
        `HTTP ${again.status} · ${againText}`);

    const merge = await fetch(`${URL_}/rest/v1/audit_log?on_conflict=client_id`, {
      method: "POST",
      headers: { ...H(dir), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(qrow),
    });
    const mergeBody = await merge.json().catch(() => null);
    chk(merge.status === 403 && /42501|row-level security/i.test(JSON.stringify(mergeBody)),
        "وبـDO UPDATE يُرفض ⇒ سجلّ التدقيق إضافة-فقط، ولهذا لا نُرسله بـmerge",
        `HTTP ${merge.status} · ${JSON.stringify(mergeBody).slice(0, 120)}`);

    const cnt = await get("audit_log", "select=id&client_id=eq." + qid, dir);
    chk((cnt.body || []).length === 1, "وصفّ واحد فقط في القاعدة بعد الإرسالات الثلاثة");
  } else {
    /* لم يُشغَّل sql/006: upsert مرفوض. نُثبت أن الحارس في العميل يُنجِح
       فالمنصّة تعمل — لكن نُعلن العلّة بدل أن نُدّعي السلامة. */
    no("upsert بمفتاح client_id ⇒ مرفوض (42P10)",
       "الفهرس الفريد على client_id جزئيّ — شغّلي sql/006_apply_004_and_005.sql");
    const ins = await insAudit();
    const insBody = await ins.json().catch(() => null);
    chk(ins.status === 201 && insBody?.length === 1,
        "والحارس في العميل (إدراج عادي) يُنجِح ⇒ الأثر يصل ولا يُجمَّد الطابور");
    ok("الخلاصة: المنصّة تعمل الآن بالإدراج، وsql/006 يُعيد upsert فيُحدِّث بدل أن يُطوي");
  }
  if (!KEEP) {
    await fetch(`${URL_}/rest/v1/audit_log?client_id=eq.${encodeURIComponent(qid)}`,
      { method: "DELETE", headers: H(dir) });
  }

  /* ---------- ⑪ النقاط: أوّل كتابة لها — بالصفّ الذي يبنيه العميل حرفيًّا ----------
     كانت تُقرأ ولا تُكتب. وهنا لا نقيس «هل سياسة grades تعمل؟» بل **هل الصفّ
     الذي يبنيه `rowFor` فعلًا يمرّ على الخادم الحقيقي؟** — بلا school_id وبلا
     recorded_by، وبـ`on_conflict` نفسه. وهذا بعينه صنف القياس الذي أخفى 42P10
     طويلًا: اختبارٌ يُرسل صفًّا آخر ينجح دائمًا ولا يُثبت شيئًا. */
  console.log("\n▸ ⑪ كتابة النقاط من دفتر المعلّمة");
  if (!tea) {
    no("لا حساب معلّمة في roster.csv — تُخطّي إثبات كتابة النقاط");
  } else {
    const stuRow = await get("students", "select=id&limit=1", stu);
    const sid = (stuRow.body || [])[0]?.id;
    chk(!!sid, "عُثر على uuid التلميذة على الخادم", JSON.stringify(stuRow.body).slice(0, 140));

    const LABEL = "إثبات آلي — يمكن حذفه";
    const gid = "vg-" + Date.now().toString(36);
    const grow = { student_id: sid, subject: "الرياضيات", term: 1, label: LABEL,
                   kind: "summative", mark: 8.5, client_id: gid };
    const put = (row, tok) => fetch(`${URL_}/rest/v1/grades?on_conflict=student_id,subject,term,label`, {
      method: "POST",
      headers: { ...H(tok), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });

    const g1 = await put(grow, tea);
    const g1b = await g1.json().catch(() => null);
    chk(g1.status === 201 && g1b?.length === 1,
        "المعلّمة تُدخل نقطةً — الصفّ كما يبنيه العميل بالضبط (بلا school_id ولا recorded_by)",
        `HTTP ${g1.status} · ${JSON.stringify(g1b).slice(0, 160)}`);
    if (g1b?.length === 1) {
      chk(!!g1b[0].school_id, "وschool_id وُسم من الخادم لا من العميل");
      chk(g1b[0].recorded_by === await whoami(tea), "وrecorded_by وُسم من الجلسة — لا يُنتحَل اسم الكاتب");
      chk(Number(g1b[0].mark) === 8.5, "والنقطة كما أُدخلت");
    }

    const g2 = await put({ ...grow, mark: 9.5 }, tea);
    chk(g2.status === 201 || g2.status === 200,
        "وإعادة الإرسال بعد انقطاع تُحدِّث لا تُكرّر", `HTTP ${g2.status}`);
    const after = await get("grades", `select=id,mark&client_id=eq.${gid}`, tea);
    chk((after.body || []).length === 1, "فصفّ واحد فقط في القاعدة بعد الإرسالين");
    chk(Number((after.body || [])[0]?.mark) === 9.5, "والنقطة صارت الجديدة (تعديل لا إهمال)");

    /* التلميذة: الصفّ نفسه سليم، وترفضه السياسة لأنّها ليست معلّمة. */
    const girl = await put({ ...grow, label: LABEL + " (من التلميذة)", client_id: gid + "-s" }, stu);
    chk(girl.status === 403, "والتلميذة لا تكتب نقاطها على الخادم الحقيقي", `HTTP ${girl.status}`);

    if (!KEEP) {
      const d1 = await fetch(`${URL_}/rest/v1/grades?client_id=eq.${encodeURIComponent(gid)}`, { method: "DELETE", headers: H(dir) });
      const d2 = await fetch(`${URL_}/rest/v1/grades?client_id=eq.${encodeURIComponent(gid + "-s")}`, { method: "DELETE", headers: H(dir) });
      ok(`حُذف أثر الإثبات (${d1.status}/${d2.status}) — والدفتر عاد كما كان`);
    }
  }

  /* ---------- ⑫ الواجب والاستدعاء وسجلّ البوابة — من يكتب، ومن يرى ----------
     ثلاثة جداول كانت مصفوفات محلّية: تنشر المعلّمة واجبًا فلا تراه تلميذة،
     وتُصدر الإدارة استدعاءً فلا تعلم به ابنُها، ويعبر التلاميذ البوابة فلا
     يُسجَّل شيء. والنقيس هنا **صفّ `rowFor` نفسه** (بلا school_id)، ثم مقروءًا
     بعين كل دور — لأنّ العطل في هذا المشروع كان دائمًا في المسافة بين ما
     يُرسَل وما يمكن رؤيته.
     وفيه إثباتٌ سلبيّ مقصود: «الكل» خيارٌ افتراضي في الواجهة وليس قسمًا في
     القاعدة ⇒ يُقبَل كتابةً ولا تراه تلميذة. هذا هو العطل الذي دفع إلى توسيعه
     في العميل، ويُقاس حيًّا كي لا يكون التوسيع دعوى. */
  console.log("\n▸ ⑫ الواجبات والاستدعاءات وسجلّ البوابة على الخادم الحقيقي");
  {
    const me = await get("students", "select=id,class_label&limit=1", stu);
    const sid = (me.body || [])[0]?.id, scls = (me.body || [])[0]?.class_label;
    chk(!!sid && !!scls, `uuid التلميذة وقسمها من الخادم («${scls}»)`,
        JSON.stringify(me.body).slice(0, 140));
    const tag = "v-" + Date.now().toString(36);
    const today = new Date().toISOString().slice(0, 10);
    /* upsert مفتاحه client_id — نفس ما يفعله العميل بالضبط */
    const up = (t, row, tok) => fetch(`${URL_}/rest/v1/${t}?on_conflict=client_id`, {
      method: "POST",
      headers: { ...H(tok), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(row),
    });

    if (tea) {
      const h1 = await up("homework",
        { class_label: scls, subject: "الرياضيات", title: "إثبات آلي — يمكن حذفه",
          due_on: null, client_id: tag + "-hw" }, tea);
      const h1b = await h1.json().catch(() => null);
      chk(h1.status === 201 && h1b?.length === 1,
          "المعلّمة تنشر واجبًا — الصفّ كما يبنيه العميل (بلا school_id ولا created_by)",
          `HTTP ${h1.status} · ${JSON.stringify(h1b).slice(0, 160)}`);
      chk(!!h1b?.[0]?.school_id, "وschool_id وُسم من الخادم لا من العميل");
      const seen = await get("homework", `select=id,class_label&client_id=eq.${tag}-hw`, stu);
      chk((seen.body || []).length === 1,
          "والتلميذة ترى واجب قسمها (كانت لا تعلم به)",
          JSON.stringify(seen.body).slice(0, 140));

      /* الإثبات السلبي: «الكل» */
      const hAll = await up("homework",
        { class_label: "الكل", subject: "الرياضيات", title: "إثبات آلي — «الكل»",
          due_on: null, client_id: tag + "-all" }, tea);
      chk(hAll.status === 201, "و«الكل» يُقبَل كتابةً (لا قيد في القاعدة يمنعه — لذا العطل صامت)");
      const seenAll = await get("homework", `select=id&client_id=eq.${tag}-all`, stu);
      chk((seenAll.body || []).length === 0,
          "لكن لا تراه تلميذة واحدة ⇒ لهذا يُوسَّع «الكل» في العميل إلى صفٍّ لكل قسم",
          "لو ظهر هنا فسياسة القراءة تغيّرت — راجعي hw_read قبل تعديل العميل");

      /* مسار الغياب (`markAbsent`) — يُقاس على **سياسة الإدراج وحدها**، وبلا
         كتابة صفٍّ حقيقيّ. سببان:
         ① `attendance` لها إدراجٌ وتحديثٌ و**لا سياسة حذف** ⇒ صفٌّ يُكتب هنا
            يبقى أبدًا ويُفسد `absDays`/`attRate` تلميذةٍ حقيقية (كل الصفوف
            تُحسب، لا صفّ اليوم وحده).
         ② و`Prefer:return=representation` يجعل PostgreSQL يطبّق سياسة
            **القراءة** على الصفّ المُعاد كذلك ⇒ قياسٌ به لا يدري أمِن
            `attendance_write` جاء الرفض أم من `can_read_student`. وقد وقعنا
            في هذا بعينه: المحاولة الأولى ردّت 42501 وبدت «السياسة ترفض
            المعلّمة»، والسبب كان `can_read_student` على uuid غير موجود.
         فـ`return=minimal` يعزل السؤال: 403 = السياسة ردّت · 409 = السياسة
         مرّرت وسقط الإدراج على المفتاح الأجنبي. وهما لا يُلتبسان. */
      const GHOST = "00000000-0000-0000-0000-000000000000";
      const insMin = (row, tok) => fetch(`${URL_}/rest/v1/attendance`, {
        method: "POST", headers: { ...H(tok), Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
      const rT = await insMin({ student_id: GHOST, day: today, state: "absent", at_time: null }, tea);
      chk(rT.status === 409,
          "المعلّمة تملك can_record ⇒ كتابة الغياب تمرّ من السياسة (تسقط على المفتاح الأجنبي 409 لا 403)",
          `HTTP ${rT.status} · ${JSON.stringify(rT.body).slice(0, 160)}`);
      chk(rT.status !== 201, "ولم يُكتب صفّ ⇒ لا تلويثَ سجلّ تلميذة");
    } else {
      no("لا حساب معلّمة في roster.csv — تُخطّى واجبات ⑫");
    }

    const s1 = await post("summons",
      { student_id: sid, reason: "إثبات آلي — يمكن حذفه", due_on: null,
        status: "مُرسَل", client_id: tag + "-sm" }, dir);
    chk(s1.status === 201, "المديرة تُصدر استدعاءً حيًّا",
        `HTTP ${s1.status} · ${JSON.stringify(s1.body).slice(0, 160)}`);
    const smSeen = await get("summons", `select=id,student_id&client_id=eq.${tag}-sm`, stu);
    chk((smSeen.body || []).length === 1, "والتلميذة ترى استدعاءها (كان لا يعلم به أحد)");

    if (tea) {
      const sBad = await post("summons",
        { student_id: sid, reason: "من المعلّمة", client_id: tag + "-smt" }, tea);
      chk(sBad.status === 403, "والمعلّمة لا تُصدر استدعاءً (للمدير والناظر وحدهما)",
          `HTTP ${sBad.status}`);
    }

    /* الأمانة على الباب: تكتب العبور ولا تُثبّت حضور اليوم — وهذا بعينه ما
       يحترمه العميل بـ`canRecord`. نقطةٌ تُقاس حيًّا لأنّ الخطأ فيها لا يظهر
       إلّا كإنذار «ردّه الخادم نهائيًّا» بعد ثماني محاولات. */
    if (recep) {
      const gl = await post("gate_log",
        { student_id: sid, at_time: "07:45", day: today, late: false, client_id: tag + "-gl" }, recep);
      chk(gl.status === 201, "الأمانة تُسجّل عبورًا في سجلّ البوابة (هي التي على الباب)",
          `HTTP ${gl.status} · ${JSON.stringify(gl.body).slice(0, 140)}`);
      const att = await post("attendance",
        { student_id: sid, day: today, state: "present", at_time: "07:45" }, recep);
      chk(att.status === 403,
          "ولا تُثبّت حضور اليوم (attendance تشترط can_record) ⇒ لهذا لا يُرسِله العميل منها",
          `HTTP ${att.status} · ${JSON.stringify(att.body).slice(0, 140)}`);
    } else {
      no("لا حساب أمانة في roster.csv — تُخطّى كتابة سجلّ البوابة");
    }

    if (!KEEP) {
      const dH = await fetch(`${URL_}/rest/v1/homework?client_id=in.("${tag}-hw","${tag}-all")`,
        { method: "DELETE", headers: H(dir) });
      const dS = await fetch(`${URL_}/rest/v1/summons?client_id=eq.${encodeURIComponent(tag + "-sm")}`,
        { method: "DELETE", headers: H(dir) });
      ok(`حُذف أثر الإثبات في الواجبات والاستدعاءات (${dH.status}/${dS.status})`);
    }
    /* سجلّ البوابة **إضافة فقط** بالقصد: لا سياسة UPDATE ولا DELETE عليه.
       فالصفّ يبقى — يُعلَن ولا يُخفى. */
    console.log(`\x1b[33m⚠️  بقي صفٌّ واحد في gate_log بـclient_id=${tag}-gl — لا سياسة حذف عليه بالقصد\x1b[0m`);
  }

  /* ---------- ⑦ وليّ الأمر: يرى ابنته وحدها — قراءةٌ فقط ----------
     لا نكتب صفًّا هنا: `notifications` بلا سياسة DELETE، فصفٌّ يكتبه الإثبات
     يبقى أبدًا على حساب طفلةٍ حقيقيّة. والعزل يُقاس بالقراءة، وهي كافية. */
  console.log("\n▸ ⑦ وليّ الأمر: RLS تُحدّد ابنته، والقناة المجّانية مقروءة");
  const parentRow = rows.find((c) => c[0] === "وليّ أمر");
  if (!parentRow) {
    console.log("\x1b[33m⚠️  تُخطّي: لا صفَّ وليّ أمر في roster.csv — أعِد تشغيل provision.mjs بعد تنفيذ sql/007\x1b[0m");
  } else if (!/^\d{6}$/.test(parentRow[4])) {
    /* الحساب موجود سلفًا ⇒ الكشف لا يحمل رمزه (لا نطبع رقمًا لا يعمل). */
    console.log("\x1b[33m⚠️  تُخطّي: رمز الوليّ غير مُدرَج في الكشف (حسابٌ موجود سلفًا — رمزه السابق هو النافذ)\x1b[0m");
  } else {
    /* تطبيعٌ مصغّر للمقارنة فقط: رقم الهاتف كما كُتب في students قد يكون
       بصيغةٍ أخرى غير الموحَّدة التي في الكشف. */
    const norm = (p) => String(p || "").replace(/\D/g, "").replace(/^(00213|213)/, "").replace(/^0+/, "");
    let par = null;
    try { par = await login(parentRow[1], parentRow[4]); }
    catch (e) { no("دخول وليّ الأمر", e.message); }
    if (par) {
      ok(`دخول ${parentRow[1]} برقم هاتفه — الصيغة الموحَّدة تعمل على الخادم`);
      const kids = await get("students", "select=id,card_no,full_name,parent_phone", par);
      chk(kids.status === 200 && Array.isArray(kids.body) && kids.body.length > 0,
          "يقرأ سجلّ أبنائه", `HTTP ${kids.status} · ${JSON.stringify(kids.body).slice(0, 140)}`);
      const body = Array.isArray(kids.body) ? kids.body : [];
      chk(body.length > 0 && body.every((s) => norm(s.parent_phone) === norm(parentRow[1])),
          `وكلّ من يراه ابنُه فعلًا (${body.length} صفًّا، ورقم وليّها يطابق)`,
          "لو ظهر غريب فالعزل مكسور — ولو ظهر صفرًا فالربط في guardians ناقص");
      const gl = await get("gate_log", "select=id", par);
      chk(gl.status === 200 && Array.isArray(gl.body) && gl.body.length === 0,
          "ولا يرى شيئًا من سجلّ البوابة (السياسة تُصفّر لا تُخطئ)",
          `HTTP ${gl.status}`);
      const kidIds = new Set(body.map((s) => s.id));
      const nt = await get("notifications", "select=id,student_id,body", par);
      chk(nt.status === 200 &&
          (nt.body || []).every((n) => n.student_id == null || kidIds.has(n.student_id)),
          "وإشعاراته تخصّ ابنه وحده (قناة التطبيق المجّانية)",
          `HTTP ${nt.status}`);
      const sub = await get("guardians_subscription", "select=paid_until,amount_dzd", par);
      chk(sub.status === 200,
          Array.isArray(sub.body) && sub.body.length
            ? `وسجلّ اشتراكه مقروء (حتى ${String(sub.body[0].paid_until).slice(0, 10)})`
            : "وسجلّ اشتراكه مقروء (لم تُسجَّل دفعة بعد — وهذا صادق لا عطب)",
          `HTTP ${sub.status} · ${JSON.stringify(sub.body).slice(0, 140)}`);
      const w = await post("notifications",
        { student_id: body[0] && body[0].id, kind: "absence", body: "إثبات" }, par);
      chk(w.status === 403, "ولا يكتب إشعارًا بنفسه (notif_insert تشترط is_staff)",
          `HTTP ${w.status} · ${JSON.stringify(w.body).slice(0, 140)}`);
    }
  }

  console.log("\n" + "─".repeat(64));
  console.log(`\x1b[1m${pass} نجح · ${fail} فشل\x1b[0m`);
  console.log(fail === 0
    ? "\x1b[32m\x1b[1mمسارات الجلب والاعتراض والكتابة تعمل حيًّا على الخادم الحقيقي.\x1b[0m\n"
    : "\x1b[31m\x1b[1mهناك فشل — راجع أعلاه.\x1b[0m\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\n\x1b[31m✗ توقّف:\x1b[0m " + (e.message || e) + "\n");
  process.exit(2);
});
