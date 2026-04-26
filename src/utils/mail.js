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

/**
 * Send a consumer-facing notification email.
 * When merchantBrand is provided, the email uses merchant branding.
 * Otherwise it uses PerkValet default branding.
 *
 * @param {object} opts
 * @param {string} opts.to - Recipient email
 * @param {string} opts.subject - Email subject
 * @param {string} opts.body - Plain text body
 * @param {object} [opts.merchantBrand] - { name, logo, color } for branded emails
 */
async function sendNotificationEmail({ to, subject, body, merchantBrand }) {
  const brandName = merchantBrand?.name || "PerkValet";
  const brandColor = merchantBrand?.color || "#0D9488";
  const brandLogo = merchantBrand?.logo;
  const poweredBy = merchantBrand ? "Powered by PerkValet" : "";

  const html = `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 0;">
      <div style="background: ${brandColor}; padding: 20px 24px; text-align: center;">
        ${brandLogo
          ? `<img src="${brandLogo}" alt="${brandName}" style="height: 40px; border-radius: 6px;" />`
          : `<div style="color: #fff; font-weight: 800; font-size: 20px;">${brandName}</div>`
        }
      </div>
      <div style="padding: 24px; color: #333; font-size: 15px; line-height: 1.6;">
        ${body.replace(/\n/g, "<br/>")}
      </div>
      <div style="padding: 16px 24px; text-align: center; border-top: 1px solid #eee; color: #999; font-size: 12px;">
        ${poweredBy ? `${poweredBy}<br/>` : ""}
        <a href="https://perksvalet.com" style="color: #0D9488;">perksvalet.com</a>
      </div>
    </div>
  `.trim();

  return sendMail({ to, subject, text: body, html });
}

module.exports = { sendMail, sendNotificationEmail };
