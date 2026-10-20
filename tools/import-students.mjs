#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — استيراد قائمة التلاميذ الحقيقية من ملفّ CSV
 *  الملف: tools/import-students.mjs
 *
 *  لماذا؟ إدخال مئات التلميذات من صفحة «إضافة تلميذة» واحدةً واحدة ليس
 *  واقعيًّا. هذا السكربت يأخذ القائمة التي تعطيها المديرة (Excel → CSV)
 *  ويُدخلها في جدول `students` **قبل** تشغيل provision.mjs.
 *
 *  الاستعمال:
 *    export SUPABASE_URL="https://xxxx.supabase.co"
 *    export SUPABASE_SERVICE_ROLE_KEY="eyJhbGci..."
 *    node tools/import-students.mjs --template          # ينشئ قالبًا فارغًا
 *    node tools/import-students.mjs students.csv --dry  # عرض بلا كتابة
 *    node tools/import-students.mjs students.csv        # الكتابة الفعلية
 *
 *  الأعمدة المقبولة (عربية أو إنجليزية، والترتيب لا يهمّ):
 *    الاسم الكامل · القسم (4ب) أو السنة + الشعبة · اسم ولي الأمر ·
 *    رقم هاتف ولي الأمر · رقم البطاقة (اختياري — يُولَّد تلقائيًّا).
 *
 *  ⚠️ التسلسل الصحيح:
 *    ① استيراد التلاميذ (هذا السكربت)
 *    ② `node tools/provision.mjs` — ينشئ حسابات التلميذات والأولياء
 *    ③ طبع البطاقات وتوزيع الكشف ثم **حذف roster.csv**
 *  ولا يُنشأ حساب وليّ إلا لصفٍّ فيه رقم جوّال صحيح.
 *
 *  ⚠️ الأمان: هذا السكربت يستعمل service_role (يتجاوز RLS). شغّله على
 *     جهازك فقط، ولا تضع المفتاح في أي ملفّ يُنشر أو يُرفع إلى Git.
 * ==========================================================================*/

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const URL_BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry");
const TEMPLATE = ARGS.includes("--template");

/* ------------------------------- أدوات البيانات ---------------------------- */

/* نفس توحيد الأرقام المستخدم عند الإنشاء وعند الدخول (index.html وprovision.mjs):
   +213 / 00213 / المسافات / الشرطات ⇒ 0XXXXXXXXX. أيّ نسخة ثانية تُنتج حسابًا
   آخر لا يستطيع الوليّ الدخول إليه. */
export function canonPhone(v){
  const raw=String(v==null?"":v).trim();
  let d=raw.replace(/\D/g,"");
  if(/^00213/.test(d)) d=d.slice(5);
  else if(/^213/.test(d)) d=d.slice(3);
  d=d.replace(/^0+/,"");
  if(!/^\d{9}$/.test(d)) return raw;   /* ليس جوّالًا ⇒ يُترك كما هو */
  return "0"+d;
}

/* مفتاح مطابقة الأسماء: التشكيل والتطويل وهمزات الألف والياء والتاء المربوطة
   لا تفرّق بين «فاطمة» و«فاطمه»، فيُمنع تكرار التلميذة عند إعادة الاستيراد. */
export function normalizeName(v){
  return String(v==null?"":v).trim().toLowerCase()
    .replace(/[ً-ْٰـ]/g,"")
    .replace(/[أإآٱ]/g,"ا").replace(/ى/g,"ي").replace(/ة/g,"ه")
    .replace(/\s+/g," ");
}

const AR_DIGITS = { "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
                    "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9" };
const asciiDigits = (s) => String(s==null?"":s).replace(/[٠-٩۰-۹]/g, (c) => AR_DIGITS[c] || c);

const GRADE_WORDS = [
  [/الاولى|الاول|اولى/, 1],
  [/الثانية|الثاني|ثانية/, 2],
  [/الثالثة|الثالث|ثالثة/, 3],
  [/الرابعة|الرابع|رابعة/, 4],
  [/الخامسة|الخامس|خامسة/, 5],
];

export function gradeOf(v){
  const s = asciiDigits(v).replace(/[أإآ]/g, "ا");
  const m = s.match(/[1-5]/);
  if (m) return +m[0];
  for (const [re, g] of GRADE_WORDS) if (re.test(s)) return g;
  return 0;
}

const SECTION_MAP = {
  "أ":"أ", "ا":"أ", "إ":"أ", "آ":"أ", "a":"أ",
  "ب":"ب", "b":"ب", "ج":"ج", "c":"ج", "د":"د", "d":"د",
};
export function normalizeSection(v){
  const s = String(v==null?"":v).trim().toLowerCase().replace(/[().\-_/\\\s]+/g,"");
  return SECTION_MAP[s] || "";
}

/* «4ب» / «4 ب» / «4/ب» / «الرابعة ابتدائي ب» / عمودان منفصلان ⇒ {4, ب}. */
export function parseClass(label, gradeCol, sectionCol){
  const raw = String(label==null?"":label).trim();
  let grade = gradeOf(gradeCol) || gradeOf(raw);
  let section = normalizeSection(sectionCol);

  if (!section) {
    /* حرف القسم بعد الرقم مباشرةً: 4ب · 4/ب · 4 - ب.
       (?![\p{L}]) يمنع قراءة «4ابتدائي» أوّل حرفٍ من كلمةٍ لا قسمًا. */
    const m = asciiDigits(raw).match(/[1-5]\s*[-\/\\ .]?\s*([أاإآAaBbCcDdبجد])(?![\p{L}])/u);
    if (m) section = normalizeSection(m[1]);
  }
  if (!section) {
    /* كلمةٌ مستقلّة من حرف واحد: «السنة الرابعة ابتدائي ب» */
    for (const tok of raw.split(/[^\p{L}]+/u)) {
      if (tok.length === 1) {
        section = normalizeSection(tok);
        if (section) break;
      }
    }
  }
  return { grade, section, class_label: grade && section ? grade + section : "" };
}

/* رقم البطاقة: 1542 → RF-1542 · RF-0007 → RF-0007 · نصّ آخر ⇒ null. */
export function normalizeCard(v){
  const s = String(v==null?"":v).trim();
  if (!s) return "";
  const m = s.match(/^(?:RF[-\s]?)?0*(\d+)$/i);
  if (!m) return null;
  return "RF-" + String(m[1]).padStart(4, "0");
}
export function cardNum(c){
  const m = String(c==null?"":c).match(/^RF-0*(\d+)$/i);
  return m ? +m[1] : 0;
}

/* ------------------------------- قراءة CSV -------------------------------- */

function decodeCSV(buf){
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)
    return { text: new TextDecoder("utf-8").decode(buf), enc: "UTF-8 (BOM)" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), enc: "UTF-8" };
  } catch {
    try {
      /* Excel العربي على Windows يحفظ أحيانًا Windows-1256 */
      return { text: new TextDecoder("windows-1256").decode(buf), enc: "Windows-1256" };
    } catch {
      throw new Error("تعذّر فكّ ترميز الملف — في Excel: حفظ باسم ← CSV UTF-8.");
    }
  }
}

function countOutsideQuotes(line, ch){
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { if (q && line[i+1] === '"') i++; else q = !q; }
    else if (!q && line[i] === ch) n++;
  }
  return n;
}

export function parseCSV(text){
  const src = String(text==null?"":text).replace(/^﻿/, "");
  const firstNl = src.indexOf("\n");
  const first = firstNl >= 0 ? src.slice(0, firstNl) : src;
  const candidates = [",", ";", "\t"]
    .map((d) => ({ d, n: countOutsideQuotes(first, d) }))
    .sort((a, b) => b.n - a.n);
  const delim = candidates[0].n ? candidates[0].d : ",";

  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') {
        if (src[i+1] === '"') { cell += '"'; i++; }
        else q = false;
      } else cell += ch;
    } else if (ch === '"') {
      q = true;
    } else if (ch === delim) {
      row.push(cell); cell = "";
    } else if (ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return { rows, delim };
}

/* ------------------------------- ربط الأعمدة ------------------------------ */

const ALIASES = {
  full_name: ["full_name","fullname","name","الاسم","الاسم الكامل","اسم التلميذة","اسم التلميذ","التلميذة","التلميذ"],
  class_label: ["class_label","classlabel","class","القسم","القسم الدراسي","السنة والقسم","الفوج"],
  grade: ["grade","السنة","السنة الدراسية","المستوى","الصف"],
  section: ["section","الشعبة","الفوج الفرعي","القسم الفرعي"],
  parent_name: ["parent_name","parentname","اسم الولي","اسم ولي الامر","ولي الامر","اسم الاب","اسم الام"],
  parent_phone: ["parent_phone","parentphone","phone","الهاتف","رقم الهاتف","رقم ولي الامر","رقم هاتف ولي الامر","هاتف الولي","رقم هاتف الولي","هاتف الاب","هاتف الام","رقم الاب","رقم الام","الجوال","الموبايل","الهاتف النقال"],
  card_no: ["card_no","cardno","card","رقم البطاقة","معرف الدخول","المعرف","رقم التعريف"],
};

function normHeader(v){
  return String(v==null?"":v).trim().toLowerCase()
    .replace(/[ً-ْٰـ]/g,"")
    .replace(/[أإآٱ]/g,"ا")
    .replace(/[^\p{L}\p{N}_]+/gu," ")
    .trim().replace(/\s+/g," ");
}

/* يعيد {role: [indices]} لأن عمودين قد يحملان الهاتف (الأب والأم) فنأخذ أوّل صالح. */
export function mapHeaders(headerRow){
  const map = {};
  headerRow.forEach((h, i) => {
    const key = normHeader(h);
    if (!key) return;
    for (const field of Object.keys(ALIASES)) {
      if (ALIASES[field].some((a) => normHeader(a) === key)) {
        (map[field] = map[field] || []).push(i);
        return;
      }
    }
  });
  return map;
}

/* --------------------------------- HTTP ---------------------------------- */
async function api(path, { method = "GET", body, headers = {} } = {}){
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

/* -------------------------------- القالب --------------------------------- */
const TEMPLATE_FILE = "students-template.csv";
function writeTemplate(){
  if (existsSync(TEMPLATE_FILE)) {
    console.error(`✖ ${TEMPLATE_FILE} موجود — لن أطمسه. انقله أو احذفه أولًا.`);
    process.exit(2);
  }
  const csv = "﻿" +
    "\"الاسم الكامل\",\"القسم\",\"اسم ولي الأمر\",\"رقم هاتف ولي الأمر\",\"رقم البطاقة\"\r\n" +
    "\"تلميذة مثال\",\"4ب\",\"وليّ التلميذة\",\"0550123456\",\"\"\r\n" +
    "\"تلميذة مثال 2\",\"1أ\",\"وليّ التلميذة\",\"0555123456\",\"\"\r\n";
  writeFileSync(TEMPLATE_FILE, csv, "utf8");
  console.log(`✔ أُنشئ ${TEMPLATE_FILE} (مستثنى من Git) — افتحه في Excel، أفرغ الأمثلة واملأ القائمة الحقيقية،`);
  console.log("  ثم احفظه CSV UTF-8 واستورده بـ: node tools/import-students.mjs students.csv --dry");
}

/* -------------------------------- البرنامج -------------------------------- */
async function main(){
  if (TEMPLATE) return writeTemplate();

  const file = ARGS.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("الاستعمال:\n  node tools/import-students.mjs students.csv [--dry]\n  node tools/import-students.mjs --template");
    process.exit(2);
  }
  if (!URL_BASE || !KEY) {
    console.error("✖ ينقص SUPABASE_URL أو SUPABASE_SERVICE_ROLE_KEY.\n  راجِع SUPABASE-SETUP.md — الخطوة ٤.");
    process.exit(2);
  }

  let buf;
  try { buf = readFileSync(file); }
  catch (e) { console.error(`✖ تعذّر قراءة ${file}: ${e.message}`); process.exit(2); }

  let decoded;
  try { decoded = decodeCSV(buf); }
  catch (e) { console.error(`✖ ${e.message}`); process.exit(2); }

  const { rows, delim } = parseCSV(decoded.text);
  if (rows.length < 2) {
    console.error("✖ الملفّ فارغ أو لا يحمل صفّ عناوين + صفًّا واحدًا على الأقلّ.");
    process.exit(2);
  }
  const header = rows[0];
  const map = mapHeaders(header);
  if (!map.full_name) {
    console.error("✖ لا أجد عمود الاسم. العناوين المقبولة: الاسم الكامل / full_name.");
    console.error("  عناوين الملفّ: " + header.map((h) => `«${h}»`).join(" · "));
    process.exit(2);
  }
  if (!map.class_label && !(map.grade && map.section)) {
    console.error("✖ لا أجد القسم. أضف عمود «القسم» (4ب) أو عمودَي «السنة» و«الشعبة».");
    process.exit(2);
  }

  console.log(`\n\x1b[1mEDUVIA — استيراد التلاميذ\x1b[0m  ${DRY ? "\x1b[33m[عرض فقط]\x1b[0m" : ""}\n`);
  console.log(`▸ الملفّ: ${file} · ${decoded.enc} · فاصل «${delim === "\t" ? "TAB" : delim}» · ${rows.length - 1} سجلًّا`);

  const schools = await api("/rest/v1/schools?select=id,name&limit=2");
  if (!schools.ok) throw new Error(`فشل قراءة المؤسسة: ${schools.status} ${schools.text.slice(0,140)}`);
  if (!schools.json?.length) {
    console.error("✖ لا توجد مؤسسة. شغّل sql/001 ثم sql/003 في محرّر SQL أولًا.");
    process.exit(1);
  }
  if (schools.json.length > 1) console.log("⚠️ أكثر من مؤسسة — سأستعمل الأولى.");
  const school = schools.json[0];
  console.log(`▸ المؤسسة: ${school.name}`);

  const ex = await api(`/rest/v1/students?select=id,card_no,full_name,class_label,parent_name,parent_phone` +
    `&school_id=eq.${encodeURIComponent(school.id)}&order=card_no`);
  if (!ex.ok) throw new Error(`فشل قراءة التلاميذ: ${ex.status} ${ex.text.slice(0,140)}`);
  const existing = ex.json || [];
  console.log(`▸ في الخادم الآن: ${existing.length} تلميذة`);

  const keyOf = (name, cls) => normalizeName(name) + "|" + String(cls==null?"":cls).trim();
  const byName = new Map();
  for (const s of existing) {
    const k = keyOf(s.full_name, s.class_label);
    if (!byName.has(k)) byName.set(k, s);
  }
  const usedCards = new Set(existing.map((s) => cardNum(s.card_no)).filter(Boolean));
  let nextCard = Math.max(0, ...existing.map((s) => cardNum(s.card_no))) + 1;

  const plan = [], bad = [], noPhone = [], warned = [];
  const seen = new Set();

  const cell = (cells, field) => {
    for (const i of map[field] || []) {
      const v = String(cells[i] == null ? "" : cells[i]).trim();
      if (v) return v;
    }
    return "";
  };

  rows.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    if (!cells.some((c) => String(c).trim())) return;   /* سطر فارغ */

    const nameRaw = cell(cells, "full_name").replace(/\s+/g, " ").trim();
    if (!nameRaw) { bad.push({ line, why: "الاسم فارغ" }); return; }
    if (nameRaw.length > 200) { bad.push({ line, why: "الاسم أطول من 200 حرف" }); return; }

    const { grade, section, class_label } = parseClass(
      cell(cells, "class_label"), cell(cells, "grade"), cell(cells, "section")
    );
    if (!grade) { bad.push({ line, why: `السنة غير مفهومة («${cell(cells,"grade")||cell(cells,"class_label")}») — استعمل 1..5` }); return; }
    if (!section) { bad.push({ line, why: `القسم غير مفهوم («${cell(cells,"class_label")||cell(cells,"section")}») — مثل 4ب` }); return; }

    /* الأب والأم قد يكونان في عمودين: أوّل رقم جوّال صالح يفوز.
       asciiDigits: لوحة المفاتيح العربية تكتب ٠٥٥٥… — تُحوَّل قبل التوحيد. */
    let phone = "", phoneRaw = "";
    for (const i of map.parent_phone || []) {
      const v = String(cells[i] == null ? "" : cells[i]).trim();
      if (!v) continue;
      const c = canonPhone(asciiDigits(v));
      if (/^0\d{9}$/.test(c)) { phone = c; phoneRaw = v; break; }
      if (!phoneRaw) phoneRaw = v;
    }
    if (!phone) noPhone.push({ line, name: nameRaw, raw: phoneRaw });

    const parentName = cell(cells, "parent_name") || ("وليّ " + nameRaw);

    const cardRaw = cell(cells, "card_no");
    let card = "";
    if (cardRaw) {
      card = normalizeCard(cardRaw);
      if (card === null) { bad.push({ line, why: `رقم بطاقة غير صالح («${cardRaw}») — مثال: RF-0012` }); return; }
    }

    const k = keyOf(nameRaw, class_label);
    if (seen.has(k)) { bad.push({ line, why: `مكرّرة داخل الملفّ: ${nameRaw} · ${class_label}` }); return; }
    seen.add(k);

    const hit = byName.get(k);
    if (hit) {
      const patch = {};
      if (String(hit.full_name || "") !== nameRaw) patch.full_name = nameRaw;
      if (String(hit.parent_name || "") !== parentName) patch.parent_name = parentName;
      if (phone && String(hit.parent_phone || "") !== phone) patch.parent_phone = phone;
      else if (!phone && phoneRaw && !hit.parent_phone) patch.parent_phone = phoneRaw;

      const wantCard = String(hit.card_no || "").toUpperCase();
      if (card && cardNum(card) !== cardNum(wantCard)) {
        if (usedCards.has(cardNum(card))) { bad.push({ line, why: `رقم البطاقة ${card} مستعمل لتلميذة أخرى` }); return; }
        warned.push({ line, why: `البطاقة في الملفّ ${card} تخالف المسجّل ${wantCard} — يُبقى المسجّل (هو مُعرِّف الدخول المطبوع).` });
      }
      plan.push({
        line, action: Object.keys(patch).length ? "update" : "same",
        name: nameRaw, class_label, card: hit.card_no, phone, patch, existing: hit,
      });
      return;
    }

    if (card && usedCards.has(cardNum(card))) {
      bad.push({ line, why: `رقم البطاقة ${card} مستعمل لتلميذة أخرى` });
      return;
    }
    if (!card) card = "RF-" + String(nextCard++).padStart(4, "0");
    usedCards.add(cardNum(card));
    plan.push({
      line, action: "insert", name: nameRaw, class_label, card, phone,
      row: {
        school_id: school.id, card_no: card, full_name: nameRaw,
        grade, section, class_label, parent_name: parentName,
        parent_phone: phone || phoneRaw || null, notify_pref: "sms",
      },
    });
  });

  /* ------------------------------ تقرير الخطة ------------------------------ */
  const ins = plan.filter((p) => p.action === "insert");
  const upd = plan.filter((p) => p.action === "update");
  const same = plan.filter((p) => p.action === "same");

  if (bad.length) {
    console.log(`\n\x1b[31m✖ ${bad.length} سجلًّا مرفوضًا — لم يُكتب شيء.\x1b[0m`);
    bad.slice(0, 25).forEach((b) => console.log(`   · سطر ${b.line}: ${b.why}`));
    if (bad.length > 25) console.log(`   … و${bad.length - 25} أخرى. صحّح الملفّ ثم أعد التشغيل.`);
    process.exit(1);
  }

  console.log(`\n▸ جديد: \x1b[32m${ins.length}\x1b[0m · تحديث: \x1b[33m${upd.length}\x1b[0m · بلا تغيير: ${same.length}`);
  if (noPhone.length) {
    console.log(`\n⚠️ بلا رقم وليّ صالح: \x1b[33m${noPhone.length}\x1b[0m — ستُستورد التلميذة،`);
    console.log("   لكن provision لن ينشئ لها حساب وليّ حتى يُضاف الرقم من صفحة التلميذة.");
    noPhone.slice(0, 15).forEach((n) => console.log(`   · سطر ${n.line}: ${n.name}${n.raw ? ` («${n.raw}») ` : ""}`));
    if (noPhone.length > 15) console.log(`   … و${noPhone.length - 15} أخرى.`);
  }
  if (warned.length) {
    console.log(`\n▸ ملاحظات (${warned.length}):`);
    warned.slice(0, 10).forEach((w) => console.log(`   · سطر ${w.line}: ${w.why}`));
  }

  console.log("\n▸ أوّل الصفوف:");
  for (const p of plan.slice(0, 12)) {
    const tag = p.action === "insert" ? "\x1b[32mجديد\x1b[0m"
              : p.action === "update" ? "\x1b[33mتحديث\x1b[0m" : "ثابت";
    console.log(`   [${tag}] ${p.card || "—"} · ${p.name} · ${p.class_label} · ${p.phone || "بلا هاتف"}`);
  }

  if (DRY) {
    console.log("\n\x1b[33m✔ عرض فقط — لم يُكتب شيء على الخادم. أزل --dry للتنفيذ.\x1b[0m\n");
    return;
  }

  /* ------------------------------- الكتابة -------------------------------- */
  let okIns = 0, okUpd = 0, fails = 0;
  for (const p of plan) {
    if (p.action === "same") continue;
    try {
      if (p.action === "update") {
        const r = await api(`/rest/v1/students?id=eq.${encodeURIComponent(p.existing.id)}` +
          `&school_id=eq.${encodeURIComponent(school.id)}`,
          { method: "PATCH", headers: { Prefer: "return=minimal" }, body: p.patch });
        if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 140)}`);
        okUpd++;
      } else {
        const r = await api("/rest/v1/students",
          { method: "POST", headers: { Prefer: "return=minimal" }, body: p.row });
        if (!r.ok) throw new Error(`${r.status} ${r.text.slice(0, 140)}`);
        okIns++;
      }
    } catch (e) {
      fails++;
      console.error(`  ✗ سطر ${p.line} — ${e.message}`);
    }
  }

  console.log(`\n✔ أُضيفت ${okIns} · حُدِّثت ${okUpd}` + (fails ? ` · \x1b[31mفشلت ${fails}\x1b[0m` : ""));
  if (fails) {
    console.error("⚠️ بعض السطور لم تُكتب — أعد التشغيل بعد تصحيحها (المكتوب لن يتكرّر: المطابقة بالاسم والقسم).");
    process.exit(1);
  }
  console.log("\nالخطوة التالية — إنشاء الحسابات:");
  console.log("  ① إن كان roster.csv موجودًا: انقله إلى roster.old.csv");
  console.log("     Move-Item roster.csv roster.old.csv");
  console.log("  ② node tools/provision.mjs");
  console.log("     (وإن لم تُوزَّع أيّ رموز بعد: node tools/provision.mjs --reset-pins ليعطيك كشفًا واحدًا كاملًا.)\n");
}

/* عند تشغيله مباشرةً فقط — كي تستطيع الاختبارات استيراد الدوالّ بلا تنفيذ. */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => { console.error(`\n✖ ${e.message}\n`); process.exit(1); });
}
