// src/utils/mail.js
const nodemailer = require("nodemailer");

const PROVIDERS = {
  mailtrap: {
    host:   process.env.MAILTRAP_HOST   || "sandbox.smtp.mailtrap.io",
    port:   Number(process.env.MAILTRAP_PORT  || 2525),
    secure: false,
    auth: {
      user: process.env.MAILTRAP_USER,
      pass: process.env.MAILTRAP_PASS,
    },
    from: process.env.MAILTRAP_FROM || process.env.ZOHO_FROM || "PerkValet <noreply@perksvalet.com>",
  },
  zoho: {
    host:   process.env.ZOHO_HOST   || "smtppro.zoho.com",
    port:   Number(process.env.ZOHO_PORT  || 465),
    secure: String(process.env.ZOHO_SECURE || "true").toLowerCase() === "true",
    auth: {
      user: process.env.ZOHO_USER,
      pass: process.env.ZOHO_PASS,
    },
    from: process.env.ZOHO_FROM || "PerkValet Admin <frank@perksvalet.com>",
  },
};

function getProvider() {
  return (process.env.MAIL_PROVIDER || "console").toLowerCase().trim();
}

async function sendMail({ to, subject, text, html }) {
  const provider = getProvider();

  if (provider === "console") {
    console.log(
      JSON.stringify({
        pvMail: "console",
        ts: new Date().toISOString(),
        to,
        subject,
        text: text?.slice(0, 200),
      })
    );
    return { ok: true, messageId: `console-${Date.now()}` };
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    throw new Error(`Unknown MAIL_PROVIDER "${provider}". Use: console | mailtrap | zoho`);
  }

  const transporter = nodemailer.createTransport({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.secure,
    auth:   cfg.auth,
  });

  const info = await transporter.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
    html,
  });

  console.log(
    JSON.stringify({
      pvMail: provider,
      ts: new Date().toISOString(),
      to,
      subject,
      messageId: info.messageId,
    })
  );

  return { ok: true, messageId: info.messageId };
}

module.exports = { sendMail };
