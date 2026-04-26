/**
 * src/i18n/t.js — Lightweight backend translation helper
 *
 * Usage:
 *   const { t, formatDate } = require("../i18n/t");
 *   t("sms.otpCode", "es", { code: "123456", minutes: 10 });
 */

"use strict";

const en = require("./en.json");
const es = require("./es.json");

const locales = { en, es };

/**
 * Translate a dotted key with optional interpolation and plural support.
 *
 * @param {string} key - Dot-notation key, e.g. "sms.otpCode"
 * @param {string} [locale="en"] - ISO 639-1 code
 * @param {object} [vars={}] - Interpolation variables; include `count` for plurals
 * @returns {string}
 */
function t(key, locale = "en", vars = {}) {
  const lang = locales[locale] || locales.en;
  const fallback = locales.en;

  // Resolve dotted key
  function resolve(obj, k) {
    return k.split(".").reduce((o, part) => o?.[part], obj);
  }

  // Plural support: if count !== 1 and a _plural key exists, use it
  let resolved = null;
  if (vars.count !== undefined && vars.count !== 1) {
    resolved = resolve(lang, key + "_plural") || resolve(fallback, key + "_plural");
  }
  if (!resolved) {
    resolved = resolve(lang, key) || resolve(fallback, key) || key;
  }

  // Interpolate {{var}}
  return resolved.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    return vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`;
  });
}

/**
 * Format a date in the given locale.
 * @param {Date|string} date
 * @param {string} [locale="en"]
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string}
 */
function formatDate(date, locale = "en", opts = { month: "short", day: "numeric", year: "numeric" }) {
  const loc = locale === "es" ? "es" : "en-US";
  return new Date(date).toLocaleDateString(loc, opts);
}

/**
 * Format cents as locale-aware currency.
 * @param {number} cents
 * @param {string} [locale="en"]
 * @param {string} [currency="USD"]
 * @returns {string}
 */
function formatCurrency(cents, locale = "en", currency = "USD") {
  const loc = locale === "es" ? "es" : "en-US";
  return new Intl.NumberFormat(loc, { style: "currency", currency }).format(cents / 100);
}

module.exports = { t, formatDate, formatCurrency };
