#!/usr/bin/env node
/* ============================================================================
 *  EDUVIA — تدقيق ساكن: الأخطاء التي لا يمسكها تشغيلٌ عابر
 *  الملف: tests/static.test.js
 *
 *  ليست اختبارات سلوك، بل **فحص بنيوي** لما لا يظهر إلّا عند ضغط زرّ بعينه
 *  أو عند إرسال قيمة بعينها. أربعة أخطاء دفعنا ثمنها في هذا المشروع ولم
 *  يكشفها أيّ اختبار سلوكي:
 *
 *    ① **زرٌّ ينادي دالةً غير موجودة.** خطأ صياغةٍ واحد في القالب، أو دالة
 *       حُذفت وبقي زرّها — فيرمي المتصفّح عند الضغط `X is not defined`،
 *       ولا يراه `node --check` (النصّ سليم نحوًا). المستخدمة تضغط فلا يحدث
 *       شيء. **لا يُكتشف إلّا بأن تُضغط كل الأزرار.**
 *    ② **دالتان بالاسم نفسه.** الثانية تحجب الأولى بصمت (JS لا يشتكي)،
 *       فيعمل نصف الملفّ على النسخة الخطأ.
 *    ③ **دالة ميّتة.** لا يناديها شيء: بقايا نسخة قديمة.
 *    ④ **قيمة عربية بلا مقابل في نوع الخادم.** الواجهة تُرسل «حاضر» والخادم
 *       لا يعرف إلّا `present` ⇒ رفض 22P02، وهو خطأ **دائم** يُسقِط الصفّ.
 *
 *  التشغيل:  node tests/static.test.js        (بلا مكتبات)
 * ==========================================================================*/
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const SCHEMA = fs.readFileSync(path.join(ROOT, "sql/001_schema.sql"), "utf8");

/* ------------------------------------------------------------- الإحصاء */
let pass = 0;
const failures = [];
const ok = (l) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${l}`); };
const bad = (l, d) => { failures.push(l); console.log(`  \x1b[31m✗\x1b[0m ${l}${d ? `\n      ↳ ${d}` : ""}`); };
const chk = (c, l, d) => (c ? ok(l) : bad(l, d));

/** رقم السطر (١-الأساس) لموضع في الملف — ليكون التقرير قابلًا للفتح مباشرة. */
const lineOf = (idx) => HTML.slice(0, idx).split("\n").length;

/** عدد تكرارات الاسم ككلمة كاملة — للتمييز بين «مستخدم» و«معرّف مرّة واحدة». */
const countWord = (name) =>
  (HTML.match(new RegExp(`(?<![\\w$])${name.replace(/[$]/g, "\\$")}(?![\\w$])`, "g")) || []).length;

/* ══════════════════════════════════════ ① لماذا هذا الفحص مهمّ ══════════
   الأزرار في هذا المشروع مكتوبة نصًّا داخل قوالب (innerHTML)، لا مربوطة
   بـaddEventListener. فلو تغيّر اسم دالة وبقي الزرّ، لا شيء يكسر: تُبنى
   الصفحة سليمة، ويُبنى الزرّ سليمًا، ويفشل **عند الضغط فقط**.
   وهذه القائمة تُستخرج من HTML نفسه، فيسقط الخطأ لحظة كتابته لا لحظة
   اكتشاف المستخدمة له. */
const HANDLER_RE =
  /\bon(click|change|input|submit|keydown|keyup|focus|blur|mouseover|mouseenter)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/* كلمات ونطاقات موجودة أصلًا في المتصفّح — لا تُعرَّف في المشروع. */
const BUILTIN = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof", "function",
  "Number", "String", "Boolean", "Array", "Object", "JSON", "Math", "Date",
  "parseInt", "parseFloat", "isNaN", "encodeURIComponent", "decodeURIComponent",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "alert",
  "confirm", "prompt", "Promise", "Error", "RegExp", "Map", "Set", "Symbol",
  "fetch", "require", "structuredClone", "queueMicrotask", "requestAnimationFrame",
]);

/** يُفرِّغ النصوص الحرفية (بين علامات تنصيص) قبل تحليل النداءات.
    بدونه يُقرأ نصٌّ عربيٌّ داخل رسالةٍ كأنّه كود: `toast('ملف PDF (محاكاة)')`
    تُنتج نداءً وهميًّا لـ`PDF()`. وهذا يُنتج إنذارات كاذبة تُفقد التدقيق ثقته. */
function stripStrings(s) {
  return s
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function collectHandlers() {
  const out = [];
  let m;
  HANDLER_RE.lastIndex = 0;
  while ((m = HANDLER_RE.exec(HTML))) {
    const body = m[2] !== undefined ? m[2] : m[3];
    out.push({ event: m[1], body: stripStrings(body), at: lineOf(m.index) });
  }
  return out;
}

/** هل التعريف في المستوى الأعلى؟ الشرط أن يبدأ **من العمود صفر**.
    التعريفات المحلّية (`const L=t=>…` داخل دالّة) مشروعة ولا تعارض شيئًا —
    فلا تُحسَب تكرارًا ولا موتًا. وتعبيرٌ مُسمّى فوريّ `(function f(){…})()`
    ليس عمود صفر (قبله قوس)، وهو يُنادى فورًا. */
function isTopLevel(html, idx) {
  const lineStart = html.lastIndexOf("\n", idx) + 1;
  return html.slice(lineStart, idx) === "";
}

/** الدوال المُناداه داخل جسم معالج: تعريفٌ يتبعه قوس — مع استثناء نداءات
    الطرق (`x.foo(`) لأنّها ليست دوالًّا عامّة. */
function calledNames(body) {
  const names = new Set();
  const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const n = m[1];
    /* `function (` ونحوها: الكلمة السابقة قوس أو فاصلة ⇒ ليست نداءً */
    const before = body.slice(Math.max(0, m.index - 12), m.index);
    if (/(function|new|typeof|return|&&|\|\||[=,:?!(]\s*)$/.test(before)) continue;
    if (!BUILTIN.has(n)) names.add(n);
  }
  return names;
}

function collectDefinitions() {
  const defs = new Map(); // name → [{line, top}]
  const add = (name, idx) => {
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push({ line: lineOf(idx), top: isTopLevel(HTML, idx) });
  };
  const pats = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>/g,
    /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const re of pats) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(HTML))) add(m[1], m.index);
  }
  return defs;
}

/* ══════════════════════════════════════ ② أنواع الخادم مقابل دلائل الواجهة ══
   الواجهة تتكلّم عربيًّا («حاضر»، «قائم») والخادم يعرف قيمًا إنجليزية
   (`present`، `open`). الجسر بينهما خريطة في العميل. فإن غاب قيمةٌ من الخريطة
   أُرسِلت العربية كما هي ⇒ رفضٌ دائم من الخادم يُسقِط الصفّ بلا رجعة. */
function enumValues(typeName) {
  const re = new RegExp(`create\\s+type\\s+${typeName}\\s+as\\s+enum\\s*\\(([^)]*)\\)`, "i");
  const m = re.exec(SCHEMA);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

function clientMap(varName) {
  const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\{([\\s\\S]*?)\\};`);
  const m = re.exec(HTML);
  if (!m) return null;
  const pairs = [];
  const pre = /(?:"([^"]*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
  let p;
  while ((p = pre.exec(m[1]))) {
    pairs.push({ key: p[1] ?? p[2] ?? p[3], val: p[4] ?? p[5] });
  }
  return pairs;
}

/* ============================================================= التشغيل */
function main() {
  console.log("\n\x1b[1mEDUVIA — تدقيق ساكن لملفّ الواجهة\x1b[0m\n");

  const defs = collectDefinitions();

  /* --------------------------------------------------------- ① الأزرار */
  console.log("▸ كل زرٍّ ينادي دالةً موجودة");
  {
    const handlers = collectHandlers();
    chk(handlers.length > 50, `عُثر على ${handlers.length} معالج حدث في الواجهة`,
      "عددٌ قليلٌ كهذا يعني أنّ الاستخراج فشل لا أنّ الأزرار قليلة");

    const missing = [];
    for (const h of handlers) {
      for (const n of calledNames(h.body)) {
        if (!defs.has(n)) missing.push(`on${h.event} (سطر ${h.at}) ينادي ${n}()`);
      }
    }
    const uniq = [...new Set(missing)];
    chk(uniq.length === 0,
      "لا زرَّ ينادي دالةً غير معرَّفة (لو وُجد لَرمى المتصفّح عند الضغط)",
      uniq.slice(0, 12).join(" · ") + (uniq.length > 12 ? ` … و${uniq.length - 12} غيرها` : ""));
  }

  /* --------------------------------------- ② التكرار (المستوى الأعلى فقط) */
  console.log("\n▸ لا دالتين بالاسم نفسه (الثانية تحجب الأولى بصمت)");
  {
    const dup = [...defs.entries()]
      .filter(([, d]) => d.filter((x) => x.top).length > 1);
    const topCount = [...defs.values()].filter((d) => d.some((x) => x.top)).length;
    chk(dup.length === 0,
      `لا اسمٌ معرَّفًا مرّتين في المستوى الأعلى (${topCount} اسمًا عامًّا من ${defs.size})`,
      dup.map(([n, d]) => `${n}() في الأسطر ${d.map((x) => x.line).join(" و")}`).join(" · "));
  }

  /* --------------------------------------------------------- ③ الميّت */
  console.log("\n▸ لا دوالّ ميّتة (اسمها لا يظهر إلّا في تعريفها)");
  {
    const dead = [];
    for (const [name, d] of defs) {
      const top = d.filter((x) => x.top);
      if (!top.length) continue;                   // محلّية ⇒ ليست دالةً عامّة
      if (top.length > 1) continue;                // مكرّرة ⇒ محسوبة أعلاه
      if (countWord(name) <= 1) dead.push(`${name}() (سطر ${top[0].line})`);
    }
    chk(dead.length === 0, "كل دالة عامّة يُنادِيها شيء",
      dead.slice(0, 15).join(" · ") + (dead.length > 15 ? ` … و${dead.length - 15} غيرها` : ""));
  }

  /* --------------------------------------------- ④ المعرّفات المطلوبة */
  console.log("\n▸ كل عنصرٍ يُطلَب بـgetElementById له أثر في الملف");
  {
    const ids = new Set();
    const re = /getElementById\(\s*(?:"([^"]+)"|'([^']+)')/g;
    let m;
    while ((m = re.exec(HTML))) ids.add(m[1] ?? m[2]);
    const ghosts = [...ids].filter((id) =>
      !HTML.includes(`id="${id}"`) && !HTML.includes(`id='${id}'`) &&
      (HTML.match(new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length <= 1);
    chk(ghosts.length === 0, `${ids.size} معرّفًا مطلوبًا — لكلّها أثر (ساكنًا أو ديناميًّا)`,
      ghosts.join(" · "));
  }

  /* ------------------------------------- ⑤ العربي مقابل أنواع الخادم */
  console.log("\n▸ كل قيمة عربية لها مقابل في نوع الخادم");
  {
    const pairs = [
      ["NOTE_STATUS_DB", "note_status"],
      ["ATT_STATE_DB", "att_state"],
      ["GRADE_KIND_DB", "grade_kind"],
    ];
    let checked = 0;
    for (const [varName, type] of pairs) {
      const map = clientMap(varName);
      const allowed = enumValues(type);
      if (!map || !allowed) continue;             // غير موجود ⇒ ليس خطأً
      checked += map.length;
      const orphan = map.filter((p) => !allowed.includes(p.val));
      chk(orphan.length === 0,
        `${varName}: قيمه كلّها في نوع الخادم ${type}`,
        orphan.map((p) => `${p.key}→${p.val}`).join(" · "));
    }
    chk(checked > 0, `فُحصت ${checked} قيمة عربية مقابل أنواع الخادم`,
      "لم تُطبَّق أيّ خريطة — تحقّق من أسماء المتغيّرات");
  }

  /* ------------------------------------ ⑥ وسم الشاشات غير الموصولة */
  /*  في الوضع الموصول، شاشةٌ تعرض بيانات مولَّدة بلا وسم = كذب على المستخدمة.
      الفحص هنا بنيويّ لا سلوكي: (أ) الخريطة موجودة ويُنادِيها render،
      (ب) **كل مفتاح فيها اسمُ قسمٍ موجود فعلًا** — فخطأ مطبعيّ («calender»)
      يجعل الوسم لا يظهر أبدًا، وهو أسوأ من غيابه لأنّه يبدو مُعالَجًا. */
  console.log("\n▸ كل شاشة غير موصولة مُعلَنة، ومفاتيح الإعلان تطابق أقسامًا موجودة");
  {
    const m = /const\s+UNBACKED\s*=\s*\{([\s\S]*?)\};/.exec(HTML);
    chk(!!m, "خريطة UNBACKED معرَّفة (تُعلن الشاشات المولَّدة في الوضع الموصول)");
    /*  «يُنادِيها render» نقيسه بالنصّ الخام بعد حذف **تعريفها** وحده:
        كل ما يبقى من الاسم لا يمكن أن يكون إلّا نداءً — فلا حاجة لتحليل
        النصوص الحرفية (وهي هشّة: تنصيصٌ شارد يُفسِد التطابق فيصير الفحص
        يكذب في الاتجاهين). */
    const withoutDef = HTML.replace(/function\s+markUnbacked[\s\S]*?\n\}/, "");
    chk(/\bmarkUnbacked\s*\(\s*\)\s*;/.test(withoutDef),
      "وrender يناديها (وإلّا فالوسم لا يظهر أبدًا)");

    if (m) {
      const keys = [...m[1].matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[1]);
      chk(keys.length >= 5, `الخريطة تُعلن ${keys.length} شاشة`,
        "عددٌ أقلّ يعني أنّ الاستخراج فشل");
      const ghosts = keys.filter((k) => !HTML.includes(`<section id="${k}"`));
      chk(ghosts.length === 0,
        "كل مفتاح في الخريطة يقابل <section> موجودًا (فلا وسمَ يضيع في الصمت)",
        ghosts.map((g) => `«${g}» ليس اسم قسم`).join(" · "));
    }
  }

  /* ------------------------------------ ⑦ الواجهة لا تُعلن حسابًا لا وجود له */
  /*  عطلٌ وقع فعلًا: جدولُ «حسابات التجربة» في الوضع المحلي كان يُعلن
      `RF-T001` برمزٍ `222222`، والخادم يطلب رمزًا آخر — فتظنّ المستخدمة أنّ
      المنصّة معطوبة وهي سليمة، **وتُبلّغ عن «رمز خاطئ»** فيُبحَث في الكود عن
      عطلٍ لا وجود له. الرمز يخصّ الخادم ولا يُكتَب هنا؛ ما نفحصه أنّ **أسماء
      الدخول المُعلَنة موجودة على الخادم**، فحينها يُهدى المستخدم إلى الكشف. */
  console.log("\n▸ كل حسابٍ يُعلنه الجدول المحلّي موجود في كشف الخادم");
  {
    const m = /const\s+DEMO_STAFF\s*=\s*\[([\s\S]*?)\];/.exec(HTML);
    chk(!!m, "جدول حسابات الوضع المحلّي معرَّف");
    const ids = m ? [...m[1].matchAll(/loginId\s*:\s*"([^"]+)"/g)].map((x) => x[1]) : [];
    chk(ids.length >= 5, `يُعلن ${ids.length} حسابًا للطاقم`);

    const ROSTER = path.join(ROOT, "roster.csv");
    if (!fs.existsSync(ROSTER)) {
      console.log("  \x1b[33m⚠️  تُخطّي: لا roster.csv — لا كشفَ للمقابلة\x1b[0m");
    } else {
      const raw = fs.readFileSync(ROSTER, "utf8").replace(/^﻿/, "");
      const rosterIds = (raw.match(/"[^"]*"/g) || []).map((c) => c.slice(1, -1));
      const ghosts = ids.filter((id) => !rosterIds.includes(id));
      chk(ghosts.length === 0,
        `${ids.length} اسمَ دخولٍ مُعلَنًا — كلّها موجودة في roster.csv`,
        ghosts.map((g) => `«${g}» ليس حسابًا على الخادم`).join(" · "));
    }

    /* والتحذير نفسه لا يُنزَع: بدونه يعود الالتباس كاملًا. */
    chk(/تختلف عن رموز الخادم|لا تعمل على الخادم/.test(HTML),
      "والواجهة تُصرّح أنّ أكواد الوضع المحلي **لا تعمل** على الخادم");
  }

  /* ------------------------------------ ⑧ الدفتر يقبل الإدخال فعلًا */
  /*  العطل الذي نمنعه هنا ليس عطلًا تقنيًّا بل **وعدًا لا يقابله شيء**:
      دفترٌ يُعرض ولا يُدخَل فيه شيء، ونقاطٌ تُقرأ من الخادم ولا تُكتب إليه.
      يبدو كل شيء سليمًا في الشاشة (الجدول يُرسم، الأرقام تظهر) والحقيقة أنّ
      ما يُدخله المعلّم يبقى في جهازه ويظنّه محفوظًا.

      ونمنع معه عطلًا ثانيًا دفعنا ثمنه في غيره: مفتاح الدفتر يجب أن يحمل
      **الفصل**، وإلّا كُتبت نقطة الفصل الثالث في خانة الفصل الأول — والقاعدة
      تقبل `term` ١..٣ بلا اعتراض، فلا رفض ينبّهنا. */
  console.log("\n▸ دفتر النقاط: يقبل الإدخال، ويُرسله، ومفتاحه يحمل الفصل");
  {
    chk(/function\s+saveBookEntry\s*\(/.test(HTML), "saveBookEntry معرَّفة (الإدخال له مسار)");
    chk(/onclick\s*=\s*"saveBookEntry\(\)"/.test(HTML), "وزرٌّ يناديها (وإلّا فالنموذج زينة)");
    chk(/enqueue\(\s*"grades"/.test(HTML), "والإدخال يُرسَل إلى جدول grades — كان يُقرأ ولا يُكتب");

    /* مفتاح الدفتر: (تلميذة | فصل | مادة) — والفصل ليس تفصيلًا. */
    const bk = /function\s+bookKey\s*\(([^)]*)\)\s*\{\s*return\s+([^;]+);/.exec(HTML);
    chk(!!bk, "bookKey معرَّفة (المفتاح في موضع واحد، لا في كل نداء)");
    if (bk) {
      chk(/\bterm\b/.test(bk[2]) && /subj/.test(bk[2]),
        "والمفتاح يشمل الفصل والمادة معًا (لا التلميذة والمادة وحدهما)");
    }
    /* الفصل يُحوَّل عند الإرسال: الواجهة ٠..٢ والقاعدة ١..٣. */
    chk(/term\s*:\s*\(\s*\+o\.term\s*\|\|\s*0\s*\)\s*\+\s*1/.test(HTML),
      "والفصل يُحوَّل +1 عند الإرسال (القاعدة تشترط ١..٣ وترفض الصفر)");

    /* وعد الواجهة يبقى: التكويني لا يُوثَّق — فلا يُرفع إلى الخادم. */
    chk(/لا يُوثَّق ولا يؤثّر/.test(HTML),
      "وعد «التكويني لا يُوثَّق» قائم في اللوحة (وإلّا صار رفعُه تناقضًا)");
    chk(/if\(kind!=="formative"\)\{/.test(HTML),
      "والكود يفي بالوعد: التكويني لا يُدرَج في الطابور");

    /* الصدق المُشتَقّ: لا نسخة مخزَّنة تتقادم بعد إدخال نقطة. */
    chk(!/marksPartial\s*=/.test(HTML),
      "«تقدير محلّي» تُشتقّ بـmarksMissing() لا تُخزَّن (المخزَّن يبقى بعد أن تُدخَل النقطة)");

    /* الإنجاء من مسح الجلب: الجلب يُعيد توزيع الأرقام المحلّية فيمسح BOOK —
       ومعها كانت تُمسح نقطةٌ أُدخلت ولم تصل الخادم، فترتدّ إلى قيمة مولَّدة
       وتبدو قد ضاعت. الحارس: الإدخال يحمل uuid، والمسح يُنجي به. */
    chk(/\.cloudId\s*=\s*row\.student_id/.test(HTML), "الإدخال يُخزّن uuid معه (به يُنجى من مسح الجلب)");
    chk(/e\.clientId&&!e\.serverId&&e\.cloudId/.test(HTML),
      "والجلب يُنجي المعلَّق قبل BOOK={} ويُعيد ربطه بالـuuid");
  }

  /* ------------------------------- ⑨ الوعد بالوصول يقابله إرسالٌ فعليّ */
  /*  عطلان من العائلة نفسها: وعدٌ في الواجهة لا يقابله شيء.
      ① «الكل» في نموذج الواجب: يُخزَّن حرفيًّا `class_label='الكل'`، وسياسة
         القراءة تشترط `s.class_label = homework.class_label` — ولا تلميذة
         اسمها قسمها «الكل» ⇒ الصفّ يراه الطاقم **ولا تراه تلميذة أبدًا**،
         والرسالة تقول إنّه سيظهر لهنّ. الحارس: التوسيع دالّة، والنموذج يناديها.
         (اختبار السلوك يقيس `homeworkRows`؛ هنا نمنع أن يبقى النموذج لا يناديها
         فتصير الدالّة المقيسة **دعوى** لا مسارًا.)
      ② حضور البوابة: شاشتها متاحة لدور الأمانة، و`attendance_write` على الخادم
         تشترط `can_record()` **والأمانة ليست فيها** ⇒ كل عبور يُردّ 42501، وهو
         ليس في PERMANENT_FAIL ⇒ ثماني محاولات ثم إنذار لا يُفهَم. الحارس:
         الإرسال مشروط بـ`canRecord` في الدالّتين، لا في إحداهما. */
  console.log("\n▸ الوعد في الواجهة يقابله إرسالٌ فعليّ (وإلّا فهو دعوى)");
  {
    const body = (fn) => {
      const i = HTML.indexOf(`function ${fn}(`);
      if (i < 0) return null;
      /* المدى: من التعريف إلى أول `\n}` في بداية سطر — يشمل الجسم كلّه. */
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? HTML.slice(i) : HTML.slice(i, j);
    };

    chk(!!body("homeworkRows"), "homeworkRows معرَّفة (توسيع «الكل» إلى صفوف)");
    chk(!!body("expandClasses"), "وexpandClasses معرَّفة (المنطق في موضع واحد)");
    const hw = body("postHomework") || "";
    chk(/homeworkRows\s*\(/.test(hw),
      "ونموذج النشر ينادي homeworkRows (وإلّا بقي الإرسال بقسمٍ اسمه «الكل»)",
      "النموذج لا يناديها ⇒ الصفّ يذهب بـclass_label='الكل' ولا تراه تلميذة");
    chk(!/class_label\s*:\s*picked|class_label\s*:\s*"الكل"/.test(HTML),
      "ولا يُبنى صفُّ واجب بقسمٍ مأخوذٍ من القائمة مباشرةً (يُوسَّع قبله)");

    /* الحضور من شاشة البوابة: الشرط في مسار التسجيل الواحد وفي التحضير اليدويّ.
       ونقلتُ منطق العبور من simulateScan إلى recordCrossing كي تمرّ المسارات
       الثلاثة (كاميرا · رقم · محاكاة) من نقطةٍ واحدة — فالقياس على الموضع الجديد،
       وإلّا صار الاختبار يقيس دالّةً لم يبقَ فيها المنطق. */
    const cross = body("recordCrossing") || "";
    const man = body("markPresent") || "";
    chk(/canRecord\s*\(currentRole\)/.test(cross),
      "الإرسال من مسار العبور مشروطٌ بـcanRecord");
    chk(/canRecord\s*\(currentRole\)/.test(man),
      "والإرسال من «تحضير يدوي» مشروطٌ به كذلك");
    chk(countWord("canRecord") >= 3,
      "وcanRecord مُستعملة فعلًا (تعريفٌ بلا نداء لا يحمي شيئًا)");
    /* الطرف الآخر: أثر العبور لا يُشترط به الدور — الأمانة لها `gate_write`. */
    chk(/enqueue\("gate_log"/.test(cross) && !/canRecord\(currentRole\)[\s\S]{0,80}enqueue\("gate_log"/.test(cross),
      "وسجلّ البوابة يُرسَل بلا شرط دور (الأمانة تكتبه على الخادم)");
    chk(/recordCrossing\(pick\(cand\)\)/.test(body("simulateScan") || ""),
      "والمحاكاة تفوّض إلى recordCrossing (لا نسخة ثانية من القواعد)");
  }

  /* ------------------------------ ⑩ الحضور لا يقول ما لم يقع -----------------
     العائلة نفسها (وعدٌ في الواجهة لا يقابله شيء)، وهذه المرّة في **الاتجاه
     المعاكس**: الواجهة تقول «حاضرة» عمّا لم يُقَيَّد أصلًا.
      ① الجلب كان يخلق كل تلميذة `state:"present"` ثم يصحّحها من صفوف اليوم
         إن وُجدت ⇒ من لا صفّ لها تُحسَب وافدة، والنسبة ١٠٠٪، والبوابة تبحث عن
         `pending` فلا تجد أحدًا فتقول «جميع التلميذات دخلن» — واللوحة تكذب على
         المديرة بلا أن يظهر خطأ واحد.
      ② شاشة التلميذة كانت ternary بوجهين ⇒ المنتظرة ترى «حاضرة» عن نفسها.
      ③ ولا واجهة كانت تكتب `absent` ⇒ غيابٌ لا يقع أبدًا على خادم حقيقيّ.
     وهذه البوّابات تسقط **لحظة كتابة الخطأ** لا لحظة استخدامه. */
  console.log("\n▸ الحضور: «لم تُسجَّل» ليست «حاضرة»، والغياب له كاتب");
  {
    const fn = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      if (i < 0) return null;
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? HTML.slice(i) : HTML.slice(i, j);
    };

    /* ① الافتراضي عند الجلب صادق — لا «حاضرة» مُخترعة. */
    chk(/state:"pending", time:null, cardState:"active", source:"server"/.test(HTML),
      "التلميذة المُجلَبة تبدأ «لم تُسجَّل» لا «حاضرة»",
      "الافتراضي `present` يجعل كل من لا صفّ لها اليوم وافدةً في العدّ والنسبة");

    /* ولا ندهس معلّقًا: غيابٌ في الطابور ينجو من الجلب (مبدأ hydration ②). */
    chk(/pendAtt\.has\(s\.cloudId\)/.test(HTML),
      "وصفُّ الحضور المعلَّق لا يُدهَس بالجلب (سقفٌ لصفّ اليوم من الخادم)");
    chk(/heldState\.get\(s\.cloudId\)/.test(HTML),
      "وحالتها المحلّية تُحفَظ قبل إعادة بناء المصفوفة وتُعاد بعدها");

    /* ② شاشة التلميذة: تُعيد استعمال الحالات الأربع لا وجهين. */
    chk(/const stt=pill\(st\.state\)/.test(HTML),
      "شاشة التلميذة تُبنى بـpill() (تعرف «لم تُسجَّل»)",
      "ternary بوجهين يُسقط المنتظرة في «حاضرة»");
    chk(!/const stt=st\.state===/.test(HTML),
      "ولا سقوطٌ إلى «حاضرة» في واجهة التلميذة");

    /* ③ الغياب له كاتب فعلًا — وقاعدةٌ لا تُخالَف: الغياب ليس عبورًا. */
    chk(/function\s+markAbsent\s*\(/.test(HTML), "markAbsent معرَّفة (للغياب مسار)");
    chk(/onclick\s*=\s*"markAbsent\(/.test(HTML), "وزرٌّ يناديها بجانب «تحضير»");
    chk(countWord("markAbsent") >= 2, "وmarkAbsent مُستعملة فعلًا (تعريفٌ بلا نداء لا يحمي شيئًا)");
    const ab = fn("markAbsent") || "";
    chk(!/enqueue\("gate_log"/.test(ab),
      "والغياب لا يكتب gate_log — سجلّ البوابة يقول ما وقع، ومن لم تعبر لم تعبر",
      "كتابةُ أثر عبورٍ لمن لم تعبر تجعل السجلّ يشهد زورًا");
    chk(/state:"absent"/.test(ab), "ويُرسل «absent» كما هو (لا قيمة عربية بلا مقابل)");
    chk(/canRecord\s*\(currentRole\)/.test(ab),
      "وحدّ الدور كحدّ التحضير (الأمانة لا تملك can_record ⇒ 42501 يُردّ ثمانيًا)");

    /* ④ النسبة تُقاس على ما قُيِّد، ولا شيء ⇒ «—» لا «٠٪». */
    chk(/const recorded=arrived\+absent/.test(HTML), "stats() تحسب «المُسجَّلات»");
    chk(/const pct=recorded\?/.test(HTML), "والنسبة على المُسجَّلات لا على الإجمالي");
    chk(countWord("pctTxt") >= 4, `pctTxt مُستعملة في مواضعها (${countWord("pctTxt")})`);
    chk(!/s\.pct\+"%"/.test(HTML), "ولا يُعرَض null كنسبة («—»)");

    /* ⑤ ومؤشّر الجهاز لا يدّعي جهازًا. */
    chk(!/kpiCard\("الجهاز"[^)]*"متّصل"/.test(HTML),
      "لا مؤشّر جهاز يقول «متّصل» وما ثمّ جهاز");
  }

  /* ------------------------- ⑪ لا تُختلق قيمة، ولا تُعرَض حالةٌ لا نعرفها -------------
     هذه هي العائلة نفسها بجذرها: **قيمةٌ مولَّدة في الكود تُعرَض كأنّها مقروءة
     من الخادم**. وقد وُجدت في مواضع لم تكن مُعلَنة في `UNBACKED` إطلاقًا:
      ① حكمٌ على **سلوك التلميذة** يُسحَب عشوائيًّا (`pick(BEHAVIORS)`) ويُعرَض
         «تقديري السلوكي العام» في لوحتها، وشاشة «المعرّضون للخطر».
      ② نِسَبُ حضور وأيام غياب عشوائية (`rand(88,99)`) قبل أن يقرأها أحد.
      ③ منحنى الأسبوع: أربعة أيام **مكتوبة في الكود** تُعرَض كتاريخ المدرسة.
      ④ لوحتا المفتّش والسلطة: دورَان لهما حسابان حقيقيّان على الخادم، تُبنى
         لوحتاهما من `INSTS` — مؤسساتٌ وأرقامٌ مكتوبة في الكود.
      ⑤ لوحة «حالة النظام»: ثلاثة صفوف مكتوبة في القالب تقول «سليمة/يعمل».
     السياسة الآن واحدة: **إمّا يُشتقّ من الخادم، وإمّا يُعلَن — ولا يُختلق.** */
  console.log("\n▸ لا قيمةَ مُختلقة: يُشتقّ من الخادم أو يُعلَن");
  {
    const fn = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      if (i < 0) return null;
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? HTML.slice(i) : HTML.slice(i, j);
    };

    /* ① + ② لا اختراع حكمٍ على التلميذة ولا نسبة. */
    const ac = fn("assignAcademics") || "";
    chk(!!ac, "assignAcademics معرَّفة");
    chk(!/pick\(BEHAVIORS\)/.test(ac),
      "لا يُسحَب تقديرٌ سلوكي عشوائيًّا للتلميذة (كان يُعرَض «تقديري السلوكي العام»)");
    chk(!/rand\(88,99\)/.test(ac),
      "ولا نسبةُ حضور عشوائية (كانت تُعرَض «نسبة حضوري ٩٤٪»)");
    chk(/students\.forEach\(s=>\{ s\.behavior=pick\(BEHAVIORS\)/.test(HTML),
      "والبيان العشوائي محصورٌ في buildData (الوضع المحلي المُعلَن)");
    chk(/function\s+behavVerdictOf\s*\(/.test(HTML) && countWord("behavVerdictOf") >= 2,
      "والتقدير السلوكي يُشتقّ من الملاحظات فعلًا (behavVerdictOf مُستعملة)");
    chk(!/\$\{esc\(st\.behavior\)\}/.test(HTML),
      "ولا يُعرَض حقلٌ مخزَّن للسلوك (المخزَّن يتقادم، والاشتقاق لا)");

    /* ③ منحنى الأسبوع من الصفوف لا من أرقام مكتوبة. */
    const wd = fn("weekData") || "";
    chk(!!wd, "weekData معرَّفة");
    chk(!/\[\s*93\.5/.test(wd),
      "ولا أرقامَ مكتوبة في الكود تُعرَض كتاريخ حضور المدرسة (البيان المحلي في DEMO_WEEK وحده)");
    chk(/DEMO_WEEK/.test(wd) && /DEMO_WEEK=\[93\.5/.test(HTML),
      "والأرقام المُصنَّعة محصورةٌ في ثابتٍ باسمه، يُستعمل في الوضع المحلي وحده");
    chk(/ATT_DAYS/.test(wd), "والمنحنى يُغذّى من سلسلة الأيام المقروءة من الخادم");
    chk(/ATT_DAYS=Object\.keys\(byDay\)/.test(HTML),
      "و`ATT_DAYS` تُملأ في الجلب من صفوف attendance نفسها");
    /* منحنى بنقطةٍ واحدة = SVG مكسور (‏x تساوي NaN) ⇒ الحارس في موضع واحد. */
    chk(/weekChartHTML\(\)/.test(fn("render") || ""),
      "ومنحنى اللوحة يمرّ بـweekChartHTML (يحرس أقلّ من نقطتين)");
    chk(!/lineChart\(weekData\(\)\)/.test(HTML),
      "ولا نداءٌ مباشر لـlineChart بلا حارس");

    /* ④ لوحتا المفتّش والسلطة مُعلَنتان: لكل قسمٍ مفتاحٌ في UNBACKED. */
    for (const k of ["ischome", "iscvisits", "isccheck", "iscnotes",
                     "obshome", "obsdropout", "obsmap", "obsreports"]) {
      chk(new RegExp(`\\b${k}\\s*:`).test(HTML) && HTML.includes(`<section id="${k}"`),
        `«${k}» مُعلَن في UNBACKED (وإلّا عرض على دورٍ حقيقيّ بياناتٍ مكتوبة في الكود بلا وسم)`);
    }

    /* ⑤ حالة النظام مشتقّة لا مكتوبة. */
    chk(!/الشبكة المحلية LAN/.test(HTML) && !/<span class="pill ok">سليمة<\/span>/.test(HTML),
      "لا صفوف حالة نظام مكتوبة في القالب («سليمة» و«يعمل» بلا فحص)");
    chk(/function\s+renderSystemStatus\s*\(/.test(HTML) && countWord("renderSystemStatus") >= 2,
      "وحالة النظام تُرسم من SYNC.mode/SYNC.online");

    /* وأخيرًا: لا قيمة افتراضية مُختلقة في صفّ الحضور. */
    chk(!/ATT_STATE_DB\[o\.state\]\s*\|\|\s*"present"/.test(HTML),
      "rowFor لا يقلب قيمةً مجهولة إلى «present» بصمت (كان يقيّد الغائبة حاضرة)");
    chk(/state:"pending",time:null,cardState:"active"/.test(HTML),
      "وتلميذةٌ تُضاف الآن تبدأ «لم تُسجَّل» لا «حاضرة»");
  }

  /* ------------------------- ⑫ وليّ الأمر: رقمٌ موحَّد، وابنته، وقناةٌ تكتب -------------
     ثلاث دعاوى كانت قائمة، كلّها بلا إثبات على الخادم:
      ① **رقم الهاتف**: `toEmail` تقلب كل ما ليس `[a-z0-9._-]` إلى شرطة ⇒
         `0555123456` و`+213555123456` ثلاثةُ حسابات، واحدٌ منها موجود.
         الأمّ تكتب رقمها بطريقتها فتُمنع، والحساب قائم.
      ② **دور `parent` غير موجود في ROLES** ⇒ `applyRole` تسقط على
         `ROLES.student`، و`meStudent` تبقى null ⇒ شاشة مكسورة لا رسالة.
      ③ **قناة «إشعار التطبيق»**: `sendAbsenceAlerts` تُعلن الإشعار وتكتبه في
         `notifs` المحلّية وحدها ⇒ وليُّ الأمر لا يعلم بغياب ابنته أبدًا،
         وهي **القناة الوحيدة التي تصل بلا مزوّد SMS**. */
  console.log("\n▸ وليّ الأمر: رقمٌ موهّد، ودورٌ له شاشة، وقناةٌ تكتب فعلًا");
  {
    const PROV = fs.readFileSync(path.join(ROOT, "tools/provision.mjs"), "utf8");
    const fn = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      if (i < 0) return null;
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? HTML.slice(i) : HTML.slice(i, j);
    };

    /* ① canonPhone — تُقاس سلوكًا لا وصفًا. */
    const canonFn = (src) => {
      const i = src.indexOf("function canonPhone(v){");
      if (i < 0) return null;
      const j = src.indexOf("\n}", i);
      if (j < 0) return null;
      try { return { fn: eval("(" + src.slice(i, j + 2) + ")"), text: src.slice(i, j + 2).replace(/\s+/g, " ").trim() }; }
      catch (e) { return null; }
    };
    const A = canonFn(HTML), B = canonFn(PROV);
    chk(!!A, "canonPhone معرَّفة في index.html");
    chk(!!B, "canonPhone معرَّفة في tools/provision.mjs");
    if (A && B) {
      chk(A.text === B.text,
        "النسختان متطابقتان نصًّا — وإلّا وُهِّد الرقمُ عند الإنشاء ولم يُوهَّد عند الدخول، فيُمنع صاحبه");
      chk(["0555123456", "+213555123456", "00213555123456", "213555123456",
           "0555 12 34 56", "555123456"].every((x) => A.fn(x) === "0555123456"),
        "وكلّ كتابات الرقم الواحد تصير 0555123456 (+213 · 00213 · مسافات · بلا صفر)");
      chk(["RF-0001", "director", "333333", "RF-T001"].every((x) => A.fn(x) === x),
        "ولا تمسّ معرّفاتٍ غير هاتفية — وإلّا مُنعت التلميذات والطاقم من الدخول");
      chk(/canonPhone\(/.test(HTML.slice(HTML.indexOf("const toEmail"))) ||
          /toEmail=loginId=>canonPhone/.test(HTML),
        "و`toEmail` تمرّ على canonPhone (التوصيل الفعليّ لا التعريف وحده)");
      chk(/canonPhone\(loginId\)/.test(PROV), "وكذلك نسخة الإنشاء في provision.mjs");
    }

    /* ② دور الوالد: شاشةٌ له، ولا صفحة إدارية تتسرّب إليه. */
    chk(/parent:\{label:"وليّ الأمر"/.test(HTML), "ROLES فيه مدخل parent");
    const pm = /parent:\{[^}]*pages:\[([^\]]*)\]/.exec(HTML);
    const ppages = pm ? pm[1].split(",").map((s) => s.replace(/["\s]/g, "")) : [];
    chk(ppages.length >= 6, `لوليّ الأمر صفحاتٌ خاصّة (${ppages.length})`);
    chk(ppages.length > 0 && ppages.every((p) => /^p[a-z]+$/.test(p)),
      "وكلّ صفحاته تبدأ بـp — فلا dashboard ولا students ولا settings");
    chk(ppages.every((p) => HTML.includes(`<section id="${p}"`)),
      "ولكلّ صفحة قسمٌ في الملف (وإلّا كتب الجناح في عنصرٍ غير موجود فرمى)");
    chk(/function\s+renderParentWing\s*\(/.test(HTML) && countWord("renderParentWing") >= 2,
      "renderParentWing معرَّفة **ومُناداة** (تعريفٌ بلا نداء لا يُظهر شيئًا)");
    chk(/if\(k==="parent"\)\{/.test(HTML), "وapplyRole تُوجّه دور parent إلى جناحه");
    chk(/r\.role==="student"\|\|r\.role==="parent"/.test(HTML),
      "وdoLogin تُعرِّف meStudent للوليّ أيضًا (وإلّا بقيت الشاشة فارغة)");
    chk(/function\s+unlinkedHTML\s*\(/.test(HTML) && countWord("unlinkedHTML") >= 2,
      "ولوليّ بلا تلميذةٍ مرتبطة شاشةٌ صريحة لا بيانات تلميذات أخريات");
    chk(/currentRole==="parent"\|\|currentRole==="student"/.test(HTML),
      "وhydrate لا تُبقي بيانات التجربة المحلّية لحسابٍ غير مرتبط");

    /* ③ القناة التي تكتب — وإلّا فهي دعوى. */
    const sa = fn("sendAbsenceAlerts") || "";
    chk(!!sa, "sendAbsenceAlerts معرَّفة");
    chk(/enqueue\("notifications"/.test(sa),
      "تنبيه الغياب **يكتب صفًّا** في notifications (وهي قناة وليّ الأمر الوحيدة بلا مزوّد)");
    chk(/case "notifications":\{/.test(HTML) && /sidOrNull\(o\.student_id\)/.test(HTML),
      "وrowFor يعرف جدول notifications ويمرّر student_id على sidOrNull (وإلّا سقط على default وأرسل رقمًا محلّيًّا إلى عمود uuid)");
    chk(/isStaffRole\(currentRole\)/.test(sa),
      "والإرسال مشروطٌ بمن تملكه السياسة (notif_insert = is_staff)");
    chk(/const isStaffRole=r=>STAFF_ROLES\.has\(r\)/.test(HTML) &&
        /"reception"\]/.test(HTML.slice(HTML.indexOf("const STAFF_ROLES"), HTML.indexOf("const STAFF_ROLES") + 200)),
      "وSTAFF_ROLES تشمل الأمانة (بخلاف can_record) كما تشملها is_staff على الخادم");

    /* ④ اسم المدرسة من الخادم لا مثبَّتًا في الكود. */
    chk(!/ابتدائية النور/.test(sa) && !/`EDUVIA — ابتدائية النور/.test(HTML),
      "نصّ رسالة الغياب لم يعد يثبّت اسم مدرسةٍ في الكود");
    chk(/function smsBody\(st\)\{return `EDUVIA — \$\{CURRENT_SCHOOL\}/.test(HTML),
      "واسم المؤسسة يأتي من CURRENT_SCHOOL المقروء من schools.name");
    /* وثلاثة مواضع أخرى كانت تثبّته: صفّ الإعدادات، وتقرير الحضور، وكشف النقاط. */
    for (const s of ["اسم المؤسسة</span><b>ابتدائية النور",
                     "تقرير الحضور اليومي — ابتدائية النور",
                     "ابتدائية النور (بنات) · الموسم الدراسي"]) {
      chk(!HTML.includes(s), `لا اسم مدرسةٍ مثبَّت في الواجهة: «${s.slice(0, 26)}…»`);
    }
    chk(/<b id="orgName">/.test(HTML) && /_orgEl\.textContent=CURRENT_SCHOOL/.test(HTML),
      "وصفّ الإعدادات يُملأ من اسم المؤسسة المقروء من الخادم");

    /* ⑤ سجلّ الاشتراك: الجدول يُضاف بـsql/007، والقراءة تتحمّل غيابه. */
    const SQL7 = fs.readFileSync(path.join(ROOT, "sql/007_guardians_subscription.sql"), "utf8");
    chk(/create table if not exists guardians_subscription/.test(SQL7),
      "sql/007 يُنشئ guardians_subscription (آمن للإعادة)");
    chk(/enable row level security/.test(SQL7) && /profile_id = auth\.uid\(\)/.test(SQL7),
      "وعليه RLS: الوليّ يقرأ سجلّه وحده");
    chk(/my_role\(\) in \('director','reception'\)/.test(SQL7),
      "والكتابة للمدير والأمانة وحدهما (لا الوليّ يمدّد اشتراكه)");
    chk(/guardians_subscription/.test(fn("hydrate") || "") &&
        /sr\.error\?null/.test(fn("hydrate") || ""),
      "وhydrate تقرأه بحذرٍ مستقلّ عن get() — فغياب الجدول ليس عطبًا");

    /* ⑥ التحديث الحيّ يبلغ وليّ الأمر — وإلّا فالغياب يُسجَّل ولا يتحرّك شيء. */
    const sig = fn("stateSignature") || "";
    chk(/s\.state/.test(sig) && /notifs\.length/.test(sig),
      "بصمة التحديث تشمل حالة الحضور وعدد الإشعارات (وكانت خارجهما ⇒ لا إعادة رسم عند الغياب)");
    const rf = fn("refreshFromServer") || "";
    chk(/renderParentWing\(\)/.test(rf) && /renderStudentWing\(\)/.test(rf),
      "والتحديث الخلفيّ يُعيد رسم الجناحين (render تبني شاشات الطاقم وحدها)");
    chk(/unlinkedHTML\(\)/.test(fn("renderStudentWing") || ""),
      "وتلميذةٌ بلا سجلّ ترى رسالةً صريحة لا صفحةً بيضاء");
    /* الحارس يقيس **السياسة** لا الكلمة: التعليق في الملفّ يذكر «الحجب» شرحًا،
       فلا يُقرأ كأنّه سياسة. والمقيس: ألّا ترد `paid_until` في أيّ create policy
       (أمثلة الاستعمال في آخر الملفّ خارج القياس). */
    const liveSQL = SQL7.split("--  تسجيل دفعة")[0];
    const policies = liveSQL.split(/create policy/).slice(1);
    chk(policies.length >= 2 && policies.every((c) => !/paid_until/.test(c)),
      "ولا سياسةَ حجبٍ بمهلة الدفع (paid_until لا يرد في أيّ create policy) — إخفاء غياب طفلة عن أمّها يضرّ الطفل");
  }

  /* ------------------------- ⑬ البراسليّ يعمل: قارئٌ يقرأ، وملصقٌ يُطبع -------------
     القرار محسوم: **بطاقة لا بصمة**، والشكل براسليّ + QR. لكن التطبيق كان
     بلا أيّ قارئ: زرُّ «محاكاة» وحده، يختار تلميذةً **عشوائيًّا** ويكتب عبورها —
     وفي الوضع الموصول كان يكتب تلميذةً عشوائية في سجلّ البوابة الحقيقيّ.
     فالبراسليّ كان زينةً، والمحاكاة خطرًا. */
  console.log("\n▸ البراسليّ: قارئٌ حقيقيّ، وملصقٌ يُطبع، ومحاكاةٌ لا تكتب عشوائيًّا");
  {
    const extractFn = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      if (i < 0) return null;
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? null : HTML.slice(i, j + 2);
    };
    let C = null;
    try { const src = extractFn("cardFromPayload"); if (src) C = eval("(" + src + ")"); }
    catch (e) { C = null; }
    chk(!!C, "cardFromPayload معرَّفة (مُستخرَجة كما هي من الملفّ)");
    if (C) {
      chk(C("RF-0001") === "RF-0001", "رقم البطاقة يمرّ كما هو");
      chk(C("   rf-25  ") === "RF-0025", "ويُطبَّع: حالة الأحرف · الفراغات · نقص الأصفار");
      chk(C("RF0010") === "RF-0010", "ويُقبَل بلا شرطة");
      chk(C("https://x.app/p?card=rf-0007") === "RF-0007", "والرابط يُقرأ منه card= لا الرابط كلّه");
      chk(C("https://x.app/RF-0003") === "RF-0003", "أو آخر مقطع من المسار");
      chk(C("مرحبا") === null && C("") === null && C(null) === null,
        "وما ليس بطاقةً يُرفَض — لا تخمين أقرب تلميذة");
    }
    for (const f of ["recordCrossing", "recordByCard", "recordCardInput",
                     "openScanner", "closeScanner", "scannerSupported", "printBraceletLabels"]) {
      chk(new RegExp(`function\\s+${f}\\s*\\(`).test(HTML), `${f} معرَّفة`);
    }
    /* المسارات كلها تمرّ من نقطةٍ واحدة — وإلّا اختلفت قواعدها. */
    chk(/function recordByCard[\s\S]*?return recordCrossing\(st\)/.test(HTML),
      "إدخال الرقم يمرّ من recordCrossing (قواعد واحدة لا نسختان)");
    chk(/function simulateScan[\s\S]*?recordCrossing\(pick\(cand\)\)/.test(HTML),
      "والمحاكاة تمرّ منه كذلك");
    chk(/recordByCard\(card\)/.test(HTML), "والكاميرا تنتهي إلى recordByCard");
    /* المحاكاة لا تظهر في الوضع الموصول: كانت تكتب تلميذةً عشوائية في الخادم. */
    chk(/demoScanBtn/.test(HTML) && /db\.style\.display=remote\?"none":""/.test(HTML),
      "والمحاكاة تُخفى في الوضع الموصول (كانت تكتب عشوائيًّا على الخادم الحقيقيّ)");
    /* البوابة: كاميرا + إدخال يدويّ (احتياط البراسليّ التالف). */
    chk(/onclick="openScanner\(\)"/.test(HTML) && /id="cardInput"/.test(HTML) &&
        /onclick="recordCardInput\(\)"/.test(HTML),
      "والبوابة فيها مسحٌ بالكاميرا وإدخالٌ يدويّ للرقم");
    /* الملصق: QR بالرقم + الرقم مطبوعًا + بلا اسم. */
    chk(/function printBraceletLabels[\s\S]*?qrSVG\(card,132\)/.test(HTML),
      "ملصق البراسليّ يولّد QR من رقم البطاقة");
    chk(/onclick="printBraceletLabels\(\)"/.test(HTML),
      "وله زرٌّ في صفحة البطاقات");
    const lbl = extractFn("printBraceletLabels") || "";
    chk(!!lbl && !/s\.name/.test(lbl),
      "ولا يُطبع اسم التلميذة على البراسليّ (فلا يُعرَف صاحبه إن ضاع)");
  }

  /* ------------------- ⑭ حذف التلميذة واسم وليّها واستعلام الأولياء -------------
     سُجّلت تلميذة مرّتين، ولم يكن في التطبيق زرّ حذف؛ وفي النموذج حقل هاتف
     بلا اسم — والاسم يُخلق آليًّا «وليّ <اسم التلميذة>».
     والأخطر: provision.mjs كان يستعلم بلا parent_phone ⇒ حلقة الأولياء تُتخطّى
     الجميع بصمت ولا يُنشأ حساب وليّ واحد، والواجهة تقول إنّها فعلت. */
  console.log("\n▸ حذف التلميذة، واسم وليّها، واستعلام الأولياء");
  {
    const fnBody = (name) => {
      const i = HTML.indexOf(`function ${name}(`);
      if (i < 0) return null;
      const j = HTML.indexOf("\n}", i);
      return j < 0 ? null : HTML.slice(i, j);
    };
    /* حقل الاسم: موجود، ومقروء فعلًا، ويُرسَل. */
    chk(/id="ns_parent"/.test(HTML), "حقل «اسم وليّ الأمر» موجود في نموذج الإضافة");
    const add = fnBody("addStudent") || "";
    chk(/ns_parent/.test(add), "وaddStudent تقرأه (وإلّا بقي الحقل زينة)");
    chk(/parent_name:pnameRaw/.test(add), "ويُرسَل إلى الخادم باسمه لا «وليّ <التلميذة>»");
    chk(/canonPhone\(document\.getElementById\("ns_phone"\)/.test(add),
      "والهاتف يُوحَّد قبل الحفظ (صيغة واحدة لحساب الوليّ)");
    /* نقيس الكود لا الشرح: تعليقٌ يذكر genPhone() ليس نداءً لها. */
    const addCode = add.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    chk(!/genPhone\(\)/.test(addCode),
      "ولا رقم وهميّ عند الفراغ (كان ينشئ حساب وليٍّ لا يعرفه أحد)");
    /* تعديل بيانات الوليّ — لا حذف وإعادة إضافة. */
    for (const f of ["editParent", "saveParent", "deleteStudent", "dropQueuedForStudent"]) {
      chk(!!fnBody(f), `${f} معرَّفة`);
    }
    chk(/pParentCard/.test(HTML) && /onclick="editParent\(\$\{st\.id\}\)"/.test(HTML),
      "وملفّ التلميذة يعرض تعديل اسم الوليّ وهاتفه");
    /* الحذف: زرٌّ للمديرة وحدها، وسياسة الخادم نفسها. */
    chk(/currentRole==="director"\?`<button class="delbtn"/.test(HTML),
      "زرّ الحذف يظهر للمديرة وحدها في القائمة");
    const del = fnBody("deleteStudent") || "";
    chk(/currentRole!=="director"/.test(del),
      "والدالّة ترفض غير المديرة (حتى لو نوديت من console)");
    chk(/op:"delete",match/.test(HTML), "والحذف يمرّ بالطابور بعملية delete صريحة");
    chk(/it\.op==="delete"[\s\S]*?\.delete\(\)\.select\("id"\)/.test(HTML),
      "وflushQueue تحذف بـ.select(id) — لأنّ RLS على DELETE تُصفّر بصمت");
    /* العطل المؤكَّد: استعلام التلاميذ في provision بلا هاتف/اسم الوليّ. */
    const PROVID = fs.readFileSync(path.join(ROOT, "tools/provision.mjs"), "utf8");
    const provSelect = (PROVID.match(/students\?select=([^"`&]+)/) || [])[1] || "";
    chk(/parent_phone/.test(provSelect),
      "provision يجلب parent_phone (بدونه تُتخطّى كل تلميذة ولا يُنشأ حساب وليّ)");
    chk(/parent_name/.test(provSelect),
      "ويجلب parent_name (اسم الوليّ الحقيقيّ لا «وليّ <التلميذة>»)");
  }

  /* ------------------------------------------------------------ الحصيلة */
  console.log("\n" + "─".repeat(64));
  console.log(`__EDUVIA_SUITE_DONE__ ok=${pass} fail=${failures.length}`);
  if (failures.length === 0) {
    console.log(`\x1b[32m\x1b[1m✅ نجح التدقيق الساكن — ${pass} تأكيدًا\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m❌ ${failures.length} خللًا من ${pass + failures.length}\x1b[0m`);
  failures.forEach((f) => console.log(`   · ${f}`));
  console.log();
  process.exit(1);
}

main();
