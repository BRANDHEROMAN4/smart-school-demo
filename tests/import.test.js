#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — استيراد التلاميذ: هل تُقرأ القائمة الحقيقية قراءةً صحيحة؟
 *  الملف: tests/import.test.js
 *
 *  لا يلمس هذا الاختبار الشبكة ولا قاعدة البيانات إطلاقًا: يقيس **التحليل**
 *  وحده — توحيد الأرقام، وفهم «4ب» بكلّ كتابة، وفكّ CSV الذي يخرج من Excel
 *  العربي (فاصلة/فاصلة منقوطة/TAB، واقتباسات، وأسطر داخل خليّة).
 *
 *  ولماذا؟ لأن خطأً واحدًا في هذه الطبقة يكتب بياناتٍ خاطئة لمئات التلميذات
 *  دفعةً واحدة، ثم يُبنى عليه حساب الوليّ — وما كُتب خاطئًا لا يُكتشف من
 *  الواجهة، لأنها تعرض ما وصل.
 * ==========================================================================*/
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, m, d) => (c ? ok(m) : no(m, d));

(async () => {
  console.log("\n\x1b[1mEDUVIA — تحليل قائمة التلاميذ\x1b[0m\n");

  const mod = await import(pathToFileURL(path.resolve(__dirname, "..", "tools", "import-students.mjs")).href);
  const { canonPhone, normalizeName, parseClass, normalizeCard, cardNum, parseCSV, mapHeaders } = mod;

  /* ------------------------------------------------ ① توحيد رقم الهاتف */
  console.log("▸ رقم الهاتف — كتابةٌ واحدة مهما كتبته الأمّ");
  for (const [input, want] of [
    ["0555123456", "0555123456"],
    ["+213 555 12 34 56", "0555123456"],
    ["00213 555 12 34 56", "0555123456"],
    ["555123456", "0555123456"],
    ["0555-12-34-56", "0555123456"],
  ]) {
    chk(canonPhone(input) === want, `«${input}» ⇒ ${want}`, `الناتج: «${canonPhone(input)}»`);
  }
  chk(canonPhone("12345") === "12345", "رقم غير جوّال يُترك كما هو (لا يُختلق رقم)");

  /* ------------------------------------------------ ② مفتاح مطابقة الأسماء */
  console.log("\n▸ مطابقة الأسماء — التشكيل والهمزة لا تُنشئ تلميذةً ثانية");
  chk(normalizeName("ملاك  الشيهاني") === "ملاك الشيهاني", "المسافات المكرّرة تُطوى");
  chk(normalizeName("أحمد") === normalizeName("احمد"), "أحمد = احمد");
  chk(normalizeName("فاطمة") === normalizeName("فاطمه"), "فاطمة = فاطمه");
  chk(normalizeName("فـاطمة") === normalizeName("فاطمة"), "التطويل يُحذف");

  /* ------------------------------------------------ ③ فهم القسم */
  console.log("\n▸ القسم — «4ب» بكلّ كتابات المديرة");
  const cls = (l, g = "", s = "") => parseClass(l, g, s);
  chk(cls("4ب").class_label === "4ب", "4ب");
  chk(cls("4 ب").class_label === "4ب", "4 ب");
  chk(cls("4/ب").class_label === "4ب", "4/ب");
  chk(cls("4-ب").class_label === "4ب", "4-ب");
  chk(cls("4ج").class_label === "4ج", "4ج");
  chk(cls("4A").class_label === "4أ", "4A ⇒ 4أ");
  chk(cls("4B").class_label === "4ب", "4B ⇒ 4ب");
  chk(cls("السنة الرابعة ابتدائي ب").class_label === "4ب", "السنة الرابعة ابتدائي ب");
  chk(cls("", "الرابعة", "ب").class_label === "4ب", "عمود السنة + عمود الشعبة");
  chk(cls("4ابتدائي ب").class_label === "4ب",
    "لا يُقرأ أوّل «ا» من «ابتدائي» قسمًا (فيُفهم القسم «ب» الصحيح)");
  chk(cls("4").section === "", "القسم الناقص لا يُخمَّن — يُرفض");
  chk(cls("", "", "").grade === 0, "السنة الناقصة لا تُخمَّن — تُرفض");

  /* ------------------------------------------------ ④ فكّ CSV */
  console.log("\n▸ CSV — كما يخرجه Excel العربي");
  let r = parseCSV('الاسم,القسم\n"ملاك, الشيهاني",4ب\n');
  chk(r.rows.length === 2 && r.rows[1][0] === "ملاك, الشيهاني" && r.rows[1][1] === "4ب",
    "فاصلة داخل الاقتباس لا تقسم الخليّة");
  r = parseCSV("الاسم;القسم\nملاك;4ب\n");
  chk(r.delim === ";" && r.rows[1][0] === "ملاك", "الفاصلة المنقوطة تُكتشف تلقائيًّا");
  r = parseCSV('الاسم\tالقسم\nملاك\t4ب\n');
  chk(r.delim === "\t" && r.rows[1][1] === "4ب", "TAB يُكتشف تلقائيًّا");
  r = parseCSV('الاسم,ملاحظة\nملاك,"سطر\nثانٍ"\n');
  chk(r.rows.length === 2 && r.rows[1][1] === "سطر\nثانٍ", "سطر جديد داخل خليّة يبقى داخل الخليّة");
  r = parseCSV('الاسم,القسم\n"ملاك ""م""",4ب\n');
  chk(r.rows[1][0] === 'ملاك "م"', "علامة الاقتباس المضاعفة تُفكّ صحيحة");

  /* ------------------------------------------------ ⑤ ربط العناوين */
  console.log("\n▸ العناوين — عربية وإنجليزية");
  let m = mapHeaders(["الاسم الكامل", "القسم", "اسم ولي الأمر", "رقم هاتف ولي الأمر", "رقم البطاقة"]);
  chk(!!m.full_name && !!m.class_label && !!m.parent_name && !!m.parent_phone && !!m.card_no,
    "كل عناوين القالب العربي تُربط");
  m = mapHeaders(["full_name", "class", "parent_name", "phone", "card_no"]);
  chk(!!m.full_name && !!m.class_label && !!m.parent_name && !!m.parent_phone && !!m.card_no,
    "وكل عناوين القالب الإنجليزي");
  m = mapHeaders(["الاسم", "السنة", "الشعبة", "هاتف الأم"]);
  chk(!!m.grade && !!m.section && !!m.parent_phone, "السنة/الشعبة/هاتف الأم تُربط كذلك");

  /* ------------------------------------------------ ⑥ أرقام البطاقات */
  console.log("\n▸ رقم البطاقة");
  chk(normalizeCard("1542") === "RF-1542", "1542 ⇒ RF-1542");
  chk(normalizeCard("RF-0007") === "RF-0007", "RF-0007 يبقى بأربعة أرقام");
  chk(normalizeCard("بطاقة") === null, "نصّ غير رقمي يُرفض");
  chk(cardNum("RF-001542") === 1542 && cardNum("RF-0007") === 7,
    "القراءة الرقمية تقبل الصيغة القديمة RF-001542");

  console.log("\n" + "─".repeat(64));
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${fail}`);
  if (fail === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجح — ${pass} تأكيدًا. قائمة التلاميذ تُقرأ صحيحة.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m❌ ${fail} خللًا من ${pass + fail}\x1b[0m\n`);
  process.exit(1);
})().catch((e) => {
  console.error(`\n✖ ${e.stack || e.message}\n`);
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${fail + 1}`);
  process.exit(1);
});
