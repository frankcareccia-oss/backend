#!/usr/bin/env node
/**
 * i18n-audit.js — Check EN/ES key parity across all i18n files
 *
 * Checks:
 *   1. Backend:      src/i18n/en.json vs src/i18n/es.json
 *   2. Admin app:    ../admin/src/i18n/en.json vs ../admin/src/i18n/es.json
 *   3. Consumer app: ../consumer-app/src/i18n/en.json vs ../consumer-app/src/i18n/es.json
 *
 * Usage:
 *   node scripts/i18n-audit.js
 *
 * Exit code 0 = all clear, 1 = issues found
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

const TARGETS = [
  { label: "Backend", en: "src/i18n/en.json", es: "src/i18n/es.json" },
  { label: "Admin", en: "../admin/src/i18n/en.json", es: "../admin/src/i18n/es.json" },
  { label: "Consumer", en: "../consumer-app/src/i18n/en.json", es: "../consumer-app/src/i18n/es.json" },
];

function flatKeys(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      keys.push(...flatKeys(v, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

let hasIssues = false;

for (const { label, en: enPath, es: esPath } of TARGETS) {
  const enFile = path.resolve(ROOT, enPath);
  const esFile = path.resolve(ROOT, esPath);

  if (!fs.existsSync(enFile)) { console.log(`⏭  ${label}: en.json not found — skipping`); continue; }
  if (!fs.existsSync(esFile)) { console.log(`⏭  ${label}: es.json not found — skipping`); continue; }

  const en = JSON.parse(fs.readFileSync(enFile, "utf8"));
  const es = JSON.parse(fs.readFileSync(esFile, "utf8"));

  const enKeys = flatKeys(en);
  const esKeys = flatKeys(es);
  const enSet = new Set(enKeys);
  const esSet = new Set(esKeys);

  const missingInEs = enKeys.filter(k => !esSet.has(k));
  const extraInEs = esKeys.filter(k => !enSet.has(k));

  // Check for untranslated (EN value === ES value, ignoring brand names and short labels)
  const SKIP_IDENTICAL = new Set(["PerkValet", "Value-Added", "Base", "Clover", "Square", "Toast", "Growth Advisor", "PIN", "POS", "QR", "SKU", "UPC", "CSV", "API"]);
  const untranslated = [];
  for (const key of enKeys) {
    if (!esSet.has(key)) continue;
    const enVal = getNestedValue(en, key);
    const esVal = getNestedValue(es, key);
    if (typeof enVal !== "string" || typeof esVal !== "string") continue;
    if (enVal === esVal && enVal.length > 3 && !SKIP_IDENTICAL.has(enVal.trim())) {
      untranslated.push(key);
    }
  }

  if (missingInEs.length === 0 && extraInEs.length === 0) {
    console.log(`✓  ${label}: ${enKeys.length} EN keys, ${esKeys.length} ES keys — all matched`);
  } else {
    hasIssues = true;
    console.log(`✗  ${label}:`);
    if (missingInEs.length > 0) {
      console.log(`   Missing in ES (${missingInEs.length}):`);
      for (const k of missingInEs.slice(0, 10)) console.log(`     - ${k}`);
      if (missingInEs.length > 10) console.log(`     ... and ${missingInEs.length - 10} more`);
    }
    if (extraInEs.length > 0) {
      console.log(`   Extra in ES (${extraInEs.length}):`);
      for (const k of extraInEs.slice(0, 10)) console.log(`     - ${k}`);
      if (extraInEs.length > 10) console.log(`     ... and ${extraInEs.length - 10} more`);
    }
  }

  if (untranslated.length > 0) {
    console.log(`   ⚠  ${untranslated.length} keys may be untranslated (EN === ES):`);
    for (const k of untranslated.slice(0, 5)) console.log(`     - ${k}`);
    if (untranslated.length > 5) console.log(`     ... and ${untranslated.length - 5} more`);
  }
}

if (hasIssues) {
  console.log("\n✗ Issues found. Fix before committing.");
  process.exit(1);
} else {
  console.log("\n✓ All i18n files in sync.");
  process.exit(0);
}

function getNestedValue(obj, dotPath) {
  // Handle both flat keys ("errors.foo.bar") and nested keys
  if (obj.hasOwnProperty(dotPath)) return obj[dotPath];
  const parts = dotPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}
