#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — نقل بطاقة: هل تُخطَّط الأرقام والكشف بلا تصادم؟
 *  الملف: tests/card.test.js
 *
 *  لا شبكة ولا قاعدة بيانات: يقيس **المنطق** الذي يسبق الكتابة، لأنّ خطأً هنا
 *  يعني حسابًا لا يستطيع الدخول (رقمٌ يفتح حسابًا آخر) أو كشفًا مطبوعًا يخالف
 *  الخادم — وهو أسوأ من فشلٍ ظاهر.
 * ==========================================================================*/
"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m, d) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, m, d) => (c ? ok(m) : no(m, d));

(async () => {
  console.log("\n\x1b[1mEDUVIA — نقل بطاقة تلميذة\x1b[0m\n");

  const {
    normalizeCard, cardNum, lowestFreeCard, cardLookupForms, patchRosterText,
  } = await import(pathToFileURL(path.resolve(__dirname, "..", "tools", "set-card.mjs")).href);

  /* ------------------------------------------------ ① تطبيع الرقم */
  console.log("▸ رقم البطاقة");
  chk(normalizeCard("RF-0001") === "RF-0001", "RF-0001 يبقى كما هو");
  chk(normalizeCard("rf-1") === "RF-0001", "حالة الأحرف ونقص الأصفار يُطبَّعان");
  chk(normalizeCard("RF0012") === "RF-0012", "بلا شرطة يُقبَل");
  chk(normalizeCard("بطاقة") === null, "نصّ غير رقمي يُرفض");
  chk(cardNum("RF-001542") === 1542, "الصيغة القديمة تُقرأ رقميًّا");

  console.log("\n▸ البحث عن بطاقة قائمة — الرقم القديم لا يُطبَّع قبل البحث");
  chk(JSON.stringify(cardLookupForms("RF-001542")) === JSON.stringify(["RF-001542", "RF-1542"]),
    "RF-001542 يُجرَّب كما هو أولًا، ثم المطبَّع");
  chk(cardLookupForms("rf 1").join("|") === "RF-1|RF-0001",
    "rf 1: النصّ ثم الشكل المطبَّع");
  chk(cardLookupForms("1542").join("|") === "RF-1542", "1542 ⇒ RF-1542");
  chk(cardLookupForms("بطاقة").length === 0, "نصّ غير رقمي لا يُولّد أشكال بحث");

  /* ------------------------------------------------ ② الرقم الشاغر */
  console.log("\n▸ صاحب الرقم المشغول يُنقل إلى أصغر شاغر");
  chk(lowestFreeCard(["RF-0001", "RF-0002", "RF-0003"]) === "RF-0004",
    "١..٣ مشغولة ⇒ RF-0004");
  chk(lowestFreeCard(["RF-0002", "RF-0010"]) === "RF-0001",
    "الشاغر الأصغر أولًا لا الأكبر+١");
  chk(lowestFreeCard(["RF-0001", "RF-0002", "RF-0003", "RF-0004", "RF-0005",
    "RF-0006", "RF-0007", "RF-0008", "RF-0009", "RF-0010", "RF-001542"]) === "RF-0011",
    "بطاقة الإبنة المعطوبة (001542) لا تُجبر العدّاد على 1543");
  chk(lowestFreeCard([]) === "RF-0001", "قائمة فارغة ⇒ RF-0001");

  /* ------------------------------------------------ ③ الكشف */
  console.log("\n▸ roster.csv — العمود الثاني وحده يتغيّر");
  const roster =
    "﻿\"نوع الحساب\",\"مُعرِّف الدخول\",\"الاسم\",\"القسم / الأبناء\",\"الرمز السري\"\r\n" +
    "\"تلميذة\",\"RF-0001\",\"مريم بن علي\",\"1أ\",\"111111\"\r\n" +
    "\"تلميذة\",\"RF-001542\",\"ملاك الشيهاني\",\"4ب\",\"222222\"\r\n" +
    "\"وليّ أمر\",\"0696185584\",\"السيد محمد الشيهاني\",\"الأبناء: ملاك الشيهاني (4ب)\",\"333333\"\r\n";

  const moves = [
    { oldCard: "RF-001542", newCard: "RF-0001" },
    { oldCard: "RF-0001", newCard: "RF-0011" },
  ];
  const after = patchRosterText(roster, moves);

  chk(after.includes("\"تلميذة\",\"RF-0001\",\"ملاك الشيهاني\""),
    "بطاقة الإبنة صارت RF-0001 في الكشف");
  chk(after.includes("\"تلميذة\",\"RF-0011\",\"مريم بن علي\""),
    "صاحبة الرقم السابق نُقلت إلى RF-0011");
  chk(!after.includes("\"RF-001542\""), "الرقم المكسور لم يبقَ في الكشف");
  chk(after.includes("\"0696185584\"") && after.includes("\"333333\""),
    "صفّ الوليّ ورموزه لم تُلمس (الاستبدال في عمود الدخول وحده)");
  chk(after.includes("الأبناء: ملاك الشيهاني (4ب)"),
    "عمود الأبناء لم يُلمس — لا استبدال في النصوص الحرة");
  chk(after.startsWith("﻿"), "علامة BOM محفوظة ليفتحه Excel بالعربية صحيحة");
  chk(after.includes("\r\n"), "نهايات أسطر Windows محفوظة");

  /* الاستبدال لا يتسلسل: RF-0001 المكتوبة للتوّ لا تُعاد إلى RF-0011. */
  const once = patchRosterText(
    "\"تلميذة\",\"RF-0001\",\"س\",\"1أ\",\"1\"\r\n",
    [{ oldCard: "RF-0001", newCard: "RF-0002" }]
  );
  chk(once.includes("\"RF-0002\""), "النقل البسيط من رقم حرّ يعمل");
  chk((after.match(/RF-0011/g) || []).length === 1,
    "RF-0011 لم تُكتب إلا في صفّها (لا تسلسل استبدالٍ)");

  console.log("\n" + "─".repeat(64));
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${fail}`);
  if (fail === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجح — ${pass} تأكيدًا. نقل البطاقة يُخطَّط بلا تصادم.\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m❌ ${fail} خللًا من ${pass + fail}\x1b[0m\n`);
  process.exit(1);
})().catch((e) => {
  console.error(`\n✖ ${e.stack || e.message}\n`);
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${fail + 1}`);
  process.exit(1);
});
