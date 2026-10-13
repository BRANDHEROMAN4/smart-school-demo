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

    /* الحضور من شاشة البوابة: الشرط في الدالّتين معًا. */
    const scan = body("simulateScan") || "";
    const man = body("markPresent") || "";
    chk(/canRecord\s*\(currentRole\)/.test(scan),
      "الإرسال من «محاكاة عبور» مشروطٌ بـcanRecord");
    chk(/canRecord\s*\(currentRole\)/.test(man),
      "والإرسال من «تحضير يدوي» مشروطٌ به كذلك");
    chk(countWord("canRecord") >= 3,
      "وcanRecord مُستعملة فعلًا (تعريفٌ بلا نداء لا يحمي شيئًا)");
    /* الطرف الآخر: أثر العبور لا يُشترط به الدور — الأمانة لها `gate_write`. */
    chk(/enqueue\("gate_log"/.test(scan) && !/canRecord\(currentRole\)[\s\S]{0,80}enqueue\("gate_log"/.test(scan),
      "وسجلّ البوابة يُرسَل بلا شرط دور (الأمانة تكتبه على الخادم)");
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
