// backend/src/mail/mail.dev.transport.js
// DEV transport: console + file sink. Never sends real email.
// Output: backend/.dev/mail/*.json

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { pvMailHook } = require("./mail.hooks");

const DEV_MAIL_DIR = path.resolve(process.cwd(), ".dev", "mail");

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function makeId() {
  // Short deterministic-ish id for filenames.
  return crypto.randomBytes(6).toString("hex");
}

function isoForFilename(d) {
  return d.toISOString().replace(/[:.]/g, "-");
}

/**
 * @param {object} msg
 * @param {string} msg.category
 * @param {string|string[]} msg.to
 * @param {string} msg.subject
 * @param {string} msg.template
 * @param {object} msg.data
 * @param {object} msg.meta
 * @param {object|null} msg.rendered
 */
async function sendViaDevTransport(msg) {
  const now = new Date();
  const id = makeId();

  const toArray = Array.isArray(msg.to) ? msg.to : [msg.to];

  const record = {
    id,
    transport: "dev",
    ts: now.toISOString(),
    category: msg.category,
    to: toArray,
    subject: safeString(msg.subject),
    template: safeString(msg.template),
    rendered: msg.rendered || null,
    data: msg.data || {},
    meta: msg.meta || {},
  };

  await ensureDir(DEV_MAIL_DIR);

  const filename = `${isoForFilename(now)}__${msg.category}__${id}.json`;
  const filePath = path.join(DEV_MAIL_DIR, filename);

  await fs.writeFile(filePath, JSON.stringify(record, null, 2), "utf8");

  // Structured hooks for downstream tooling
  pvMailHook("mail.dev.written", {
    mailId: id,
    category: msg.category,
    toCount: toArray.length,
    filePath,
  });

  // Human-friendly console line
  console.log(
    `[mail:dev] wrote ${msg.category} to ${toArray.join(", ")} => ${path.relative(
      process.cwd(),
      filePath
    )}`
  );

  return {
    ok: true,
    transport: "dev",
    id,
    filePath,
  };
}

module.exports = {
  sendViaDevTransport,
  DEV_MAIL_DIR,
};
