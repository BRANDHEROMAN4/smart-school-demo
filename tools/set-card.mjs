#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — تغيير رقم بطاقة تلميذة (وهو نفسُه مُعرِّف الدخول) بأمان
 *  الملف: tools/set-card.mjs
 *
 *  لماذا سكربت لا تعديل يدويّ؟ لأنّ رقم البطاقة ليس ملصقًا على ورق:
 *    ① `students.card_no`            — ما تراه المنصّة
 *    ② `profiles.login_id`           — ما يبحث عنه `eduviaLogin`
 *    ③ بريد Supabase Auth            — `rf-0001@eduvia.local` (والدخول يبني عليه)
 *    ④ `roster.csv`                  — الكشف المطبوع
 *  تغيير واحدٍ منها وحده يجعل البطاقة لا تفتح الحساب، أو يُصادم قيدًا فريدًا
 *  في منتصف العملية. وهذا السكربت يغيّرها معًا، بالترتيب الذي لا يصطدم، ويعيد
 *  كلَّ شيء كما كان إن فشل أيّ خطوة.
 *
 *  والرقم المشغول لا يُترك مزدوجًا: صاحبُه يُنقل إلى **أصغر رقم شاغر**، وليس
 *  إلى رقمٍ مكسور. (رقم الملفّ القديم RF-001542 هو أثر عطلٍ سابق: سبعة أرقام.)
 *
 *  الاستعمال (PowerShell — المفتاح يبقى على جهازك، لا يُرسَل لأحد):
 *    $env:SUPABASE_URL="https://xxxx.supabase.co"
 *    $env:SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."
 *    node tools/set-card.mjs --from RF-001542 --to RF-0001 --dry
 *    node tools/set-card.mjs --from RF-001542 --to RF-0001
 *
 *  ⚠️ الرمز السرّي **لا يتغيّر**: يتغيّر مُعرِّف الدخول وحده. الكشف يُحدَّث
 *     في مكانه (roster.csv) إن وُجد.
 * ==========================================================================*/

import { readFileSync, writeFileSync, existsSync, openSync, closeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");
const flag = (name) => {
  const i = ARGS.indexOf(name);
  return i >= 0 ? (ARGS[i + 1] || "") : "";
};
const FROM_RAW = flag("--from");
const TO = normalizeCard(flag("--to"));

/* ------------------------------------------------------------- أدوات صافية */

/* 1542 → RF-1542 · RF-0007 → RF-0007 · نصّ آخر ⇒ null. */
export function normalizeCard(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.match(/^(?:RF[-\s]?)?0*(\d+)$/i);
  if (!m) return null;
  return "RF-" + String(m[1]).padStart(4, "0");
}
export function cardNum(c) {
  const m = String(c == null ? "" : c).match(/^RF-0*(\d+)$/i);
  return m ? +m[1] : 0;
}

/* أشكال البحث عن بطاقة قائمة. **الرقم القديم RF-001542 يبقى كما هو**:
   `normalizeCard` تُعيد RF-1542 (تزيل الصفر الزائد)، وهذا صحيح للتوليد لا
   للبحث — فلو بحثنا بالشكل المطبَّع وحده لما وجدنا البطاقة القائمة أصلًا.
   نجرّب أولًا النصّ كما كُتب (مع RF-)، ثم الشكل المطبَّع. */
export function cardLookupForms(v) {
  const s = String(v == null ? "" : v).trim().toUpperCase().replace(/[\s-]+/g, "-");
  if (!/^(?:RF-?)?\d+$/.test(s)) return [];
  const digits = s.replace(/^RF-?/, "");
  const forms = ["RF-" + digits];
  const norm = normalizeCard(s);
  if (norm && !forms.includes(norm)) forms.push(norm);
  return forms;
}

/* أصغر رقم بطاقة غير مستعمل — لا نُنزل صاحب الرقم المشغول إلى رقمٍ مكسور. */
export function lowestFreeCard(usedCards) {
  const used = new Set((usedCards || []).map(cardNum).filter(Boolean));
  let n = 1;
  while (used.has(n)) n++;
  return "RF-" + String(n).padStart(4, "0");
}

/* يحدّث عمود مُعرِّف الدخول (العمود الثاني) وحده في كشف roster.csv.
   كل الحقول مقتَبسة، وفكُّ السطر باحترام الاقتباس يمنع أن يُلمس اسمٌ أو
   ملاحظةٌ تحمل رقمًا يشبه البطاقة. والاستبدال دفعةً واحدة كي لا يُعيد
   استبدالُ RF-0001 كتابةَ ما كُتب لتوّه. */
function splitQuotedLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '"') { i++; continue; }
    let v = "";
    i++;
    while (i < line.length) {
      if (line[i] === '"') {
        if (line[i + 1] === '"') { v += '"'; i += 2; continue; }
        i++;
        break;
      }
      v += line[i++];
    }
    out.push(v);
    if (line[i] === ",") i++;
  }
  return out;
}

export function patchRosterText(text, moves) {
  const map = new Map(
    (moves || []).map((m) => [String(m.oldCard || "").trim().toUpperCase(), m.newCard])
  );
  const src = String(text == null ? "" : text);
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const lines = src.split(/\r?\n/);
  return lines.map((line, idx) => {
    const bom = idx === 0 && line.charCodeAt(0) === 0xfeff ? "﻿" : "";
    const body = bom ? line.slice(1) : line;
    if (!body.trim()) return line;
    const fields = splitQuotedLine(body);
    if (fields.length < 2) return line;
    const next = map.get(String(fields[1]).trim().toUpperCase());
    if (!next) return line;
    fields[1] = next;
    return bom + fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(",");
  }).join(eol);
}

/* بريد Auth الاصطناعي — نفس صيغة provision.mjs (نُسخةٌ لا استيرادًا لأنّ
   provision ينفّذ main() عند الاستيراد). */
const toEmail = (loginId) =>
  `${String(loginId).toLowerCase().replace(/[^a-z0-9._-]/g, "-")}@eduvia.local`;

/* ---------------------------------------------------------------- HTTP ---- */
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

const one = async (path, what) => {
  const r = await api(path);
  if (!r.ok) throw new Error(`فشل قراءة ${what}: ${r.status} ${r.text.slice(0, 140)}`);
  return (r.json || [])[0] || null;
};

/* ---------------------------------------------------------------- البرنامج */
async function main() {
  if (!FROM_RAW || !TO) {
    console.error("✖ الاستعمال:\n  node tools/set-card.mjs --from RF-001542 --to RF-0001 [--dry]");
    process.exit(2);
  }
  if (!URL_BASE || !KEY) {
    console.error("✖ ينقص SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY.\n  راجِع SUPABASE-SETUP.md — الخطوة ٤.");
    process.exit(2);
  }

  console.log(`\n[1mEDUVIA — نقل بطاقة[0m  ${DRY ? "[33m[عرض فقط][0m" : ""}\n`);

  /* البحث بأشكال الرقم: النصّ كما كُتب أولًا (RF-001542 يبقى 001542)، ثم
     الشكل المطبَّع. البحث بالمطبَّع وحده أخفق حيًّا: بطاقة الإبنة القديمة
     صارت RF-1542 فلم تُوجد. */
  const forms = cardLookupForms(FROM_RAW);
  if (!forms.length) {
    console.error(`✖ رقم بطاقة غير مفهوم: «${FROM_RAW}» — مثال: RF-0001`);
    process.exit(2);
  }
  let mover = null;
  for (const form of forms) {
    mover = await one(
      `/rest/v1/students?select=id,school_id,card_no,full_name,class_label&card_no=eq.${encodeURIComponent(form)}`,
      `التلميذة ${form}`
    );
    if (mover) break;
  }
  if (!mover) {
    console.error(`✖ لا توجد تلميذة برقم البطاقة ${FROM_RAW} (جُرِّب: ${forms.join(" · ")}).`);
    process.exit(1);
  }
  const FROM = mover.card_no;
  if (FROM.toUpperCase() === TO) {
    console.error("✖ الرقم القديم والجديد واحد — لا شيء لفعله.");
    process.exit(2);
  }
  const occupant = await one(
    `/rest/v1/students?select=id,school_id,card_no,full_name,class_label&card_no=eq.${encodeURIComponent(TO)}`,
    `التلميذة ${TO}`
  );
  if (occupant && occupant.school_id !== mover.school_id) {
    console.error(`✖ ${TO} مسجَّل في مؤسسة أخرى — لن أنقله بين مؤسستين.`);
    process.exit(1);
  }

  /* الحساب المرتبط بكل تلميذة: profiles.student_id هو الجسر إلى auth.users. */
  const profileOf = async (studentId) => one(
    `/rest/v1/profiles?select=id,login_id,display_name,role&student_id=eq.${encodeURIComponent(studentId)}`,
    "ملفّ الحساب"
  );
  const moverProf = await profileOf(mover.id);
  const occupantProf = occupant ? await profileOf(occupant.id) : null;

  const all = await api(
    `/rest/v1/students?select=card_no&school_id=eq.${encodeURIComponent(mover.school_id)}`
  );
  if (!all.ok) throw new Error(`فشل قراءة بطاقات المؤسسة: ${all.status} ${all.text.slice(0, 140)}`);
  const used = (all.json || []).map((s) => s.card_no);

  /* الترتيب مقصود: صاحبُ الرقم المشغول يُنقل أولًا إلى رقمٍ شاغر، ثم تنتقل
     صاحبة الطلب إلى رقمها الذي صار شاغرًا — فلا يمرّ أيّ تحديث بقيدٍ فريد
     مشغول، ولا نحتاج قيمًا مؤقّتة. */
  const moves = [];
  if (occupant) {
    moves.push({
      student: occupant, profile: occupantProf, oldCard: TO,
      newCard: lowestFreeCard(used),
    });
  }
  moves.push({ student: mover, profile: moverProf, oldCard: FROM, newCard: TO });

  console.log("▸ ما سيحدث:");
  for (const m of moves) {
    console.log(`   · ${m.newCard === TO ? "البطاقة المطلوبة" : "صاحب الرقم المشغول"}: ` +
      `${m.student.full_name} (${m.student.class_label || "بلا قسم"}) · ` +
      `${m.oldCard} ← [32m${m.newCard}[0m`);
    if (!m.profile) console.log("     ⚠️ لا ملفّ حساب مرتبط — سيُحدَّث رقم الطالب وحده (شغّل provision لاحقًا).");
  }
  console.log("▸ يُحدَّث معًا: students.card_no · profiles.login_id · بريد Auth" +
    (existsSync("roster.csv") ? " · roster.csv" : "") + ".");

  if (DRY) {
    console.log("\n[33m✔ عرض فقط — لم يُكتب شيء. أزل --dry للتنفيذ.[0m\n");
    return;
  }

  /* لا نبدأ الكتابة والكشف مقفول في Excel: سننتهي بحساباتٍ تغيّر مُعرِّفها
     والورقة تقول رقمًا آخر. نفحص القفل أولًا، مثل provision. */
  if (existsSync("roster.csv")) {
    try { closeSync(openSync("roster.csv", "a")); }
    catch (e) {
      console.error(`[31m✖ لا يمكن الكتابة في roster.csv (${e.code}).[0m`);
      console.error("  أغلقْه في Excel ثم أعد التشغيل — لم يتغيّر شيء بعد.");
      process.exit(2);
    }
  }

  /* كل خطوة تُسجَّل في undo؛ الفشل يعيد الحالة السابقة بترتيب معاكس. */
  const undo = [];

  try {
    for (const m of moves) {
      /* أ) بريد Auth — أولًا كي يكون الحساب قابلًا للدخول بالمُعرِّف الجديد
         في اللحظة التي يتغيّر فيها profiles.login_id. */
      if (m.profile) {
        const oldEmail = toEmail(m.oldCard);
        const newEmail = toEmail(m.newCard);
        const r = await api(`/auth/v1/admin/users/${m.profile.id}`, {
          method: "PUT",
          body: { email: newEmail, email_confirm: true },
        });
        if (!r.ok) throw new Error(`تعذّر تغيير بريد ${m.oldCard}: ${r.status} ${r.text.slice(0, 160)}`);
        undo.push(async () => api(`/auth/v1/admin/users/${m.profile.id}`, {
          method: "PUT", body: { email: oldEmail, email_confirm: true },
        }));
      }

      /* ب) profiles.login_id — ما يبحث عنه التطبيق عند الدخول. */
      if (m.profile) {
        const r = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(m.profile.id)}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: { login_id: m.newCard },
        });
        if (!r.ok) throw new Error(`تعذّر تغيير مُعرِّف ${m.oldCard}: ${r.status} ${r.text.slice(0, 160)}`);
        undo.push(async () => api(`/rest/v1/profiles?id=eq.${encodeURIComponent(m.profile.id)}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: { login_id: m.oldCard },
        }));
      }

      /* ج) students.card_no — رقم البطاقة الذي تعرضه المنصّة. */
      const r = await api(
        `/rest/v1/students?id=eq.${encodeURIComponent(m.student.id)}` +
        `&school_id=eq.${encodeURIComponent(m.student.school_id)}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { card_no: m.newCard } }
      );
      if (!r.ok) throw new Error(`تعذّر تغيير بطاقة ${m.oldCard}: ${r.status} ${r.text.slice(0, 160)}`);
      undo.push(async () => api(
        `/rest/v1/students?id=eq.${encodeURIComponent(m.student.id)}` +
        `&school_id=eq.${encodeURIComponent(m.student.school_id)}`,
        { method: "PATCH", headers: { Prefer: "return=minimal" }, body: { card_no: m.oldCard } }
      ));
    }
  } catch (e) {
    console.error(`\n[31m✖ ${e.message}[0m`);
    console.error("⏪ أُعيد الحالة السابقة…");
    let rollbackFail = 0;
    for (const fn of undo.reverse()) {
      try { await fn(); } catch { rollbackFail++; }
    }
    if (rollbackFail) {
      console.error(`[31m⚠️ تعذّر إرجاع ${rollbackFail} خطوة. راجِع students وprofiles وAuth يدويًّا قبل أيّ توزيع.[0m`);
    } else {
      console.error("✔ أُعيد كلُّ شيء كما كان — لم يتغيّر شيء.");
    }
    process.exit(1);
  }

  /* ------------------------------------------------------- الكشف المطبوع */
  let rosterNote = "لا يوجد roster.csv";
  if (existsSync("roster.csv")) {
    try {
      const before = readFileSync("roster.csv", "utf8");
      const after = patchRosterText(before, moves);
      if (after !== before) {
        writeFileSync("roster.csv", after, "utf8");
        rosterNote = "حُدِّث فيها مُعرِّف الدخول للصفوف المعنيّة (الرموز كما هي)";
      } else {
        rosterNote = "[33mلم أجد الرقم القديم فيها — راجعها يدويًّا[0m";
      }
    } catch (e) {
      rosterNote = `[31mتعذّر تحديثها (${e.code || e.message}) — صحّحها يدويًّا[0m`;
    }
  }

  /* ------------------------------------------------------------ التحقّق */
  const seen = [];
  for (const m of moves) {
    const s = await one(
      `/rest/v1/students?select=card_no,full_name&id=eq.${encodeURIComponent(m.student.id)}`,
      "التحقّق من الطالب"
    );
    const p = m.profile
      ? await one(`/rest/v1/profiles?select=login_id&id=eq.${encodeURIComponent(m.profile.id)}`, "التحقّق من الحساب")
      : null;
    seen.push({
      name: s?.full_name || m.student.full_name, card: s?.card_no,
      login: p?.login_id, wantProfile: !!m.profile, wantCard: m.newCard,
    });
  }

  console.log("\n✔ نُقلت البطاقة.");
  for (const s of seen) {
    const okCard = s.card === s.wantCard;
    const okLogin = !s.wantProfile || s.login === s.card;
    console.log(`   ${okCard && okLogin ? "[32m✓[0m" : "[31m✗[0m"} ` +
      `${s.name} · ${s.card}${s.wantProfile ? ` · الدخول: ${s.login}` : ""}`);
  }
  console.log(`   [2mroster.csv: ${rosterNote}[0m`);
  console.log("\nالرمز السرّي لا يتغيّر. أعد تحميل التطبيق (أو افتحه من جديد) ليجلب الرقم الجديد.\n");
}

/* عند التشغيل المباشر فقط — كي تستورد الاختبارات الدوالّ الصافية بلا شبكة. */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
}
