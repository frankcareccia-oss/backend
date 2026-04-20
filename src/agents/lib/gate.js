/**
 * gate.js — Output change detection for the agent pipeline
 *
 * Between every step, checks if the output file actually changed.
 * If unchanged, downstream steps can be skipped.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Run a step with gate logic.
 * @param {string} outputPath — file to check for changes
 * @param {Function} runFn — async function to execute
 * @returns {{ changed: boolean, hashBefore, hashAfter, durationMs }}
 */
async function gate(outputPath, runFn) {
  const hashBefore = hashFile(outputPath);
  const start = Date.now();

  await runFn();

  const durationMs = Date.now() - start;
  const hashAfter = hashFile(outputPath);
  const changed = hashBefore !== hashAfter;

  return { changed, hashBefore, hashAfter, durationMs };
}

module.exports = { gate, hashFile };
