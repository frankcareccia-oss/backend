// backend/src/mail/templates/security.device_verify.js
// Security-V1: device verification email template.
// Contract: export (data) => { subject, text, html? }

"use strict";

function safeString(v) {
  if (v == null) return "";
  return String(v).trim();
}

// Minimal HTML escaping for interpolated text.
function escHtml(s) {
  return safeString(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = function securityDeviceVerifyTemplate(data) {
  const toEmail = safeString(data?.toEmail || data?.email);
  const link = safeString(data?.link);
  const returnTo = safeString(data?.returnTo) || "/merchants";

  const subject = safeString(data?.subject) || "Verify this device for PerkValet admin access";

  const lines = [
    "You signed in as a PerkValet administrator.",
    "",
    "To enable this computer for admin actions, click the link below:",
    link || "(missing link)",
    "",
    `After verification, you'll return to: ${returnTo}`,
    "",
    "If you did not request this, you can ignore this email.",
  ];

  const safeLink = escHtml(link || "");
  const safeReturnTo = escHtml(returnTo);

  const buttonHtml = link
    ? `<a href="${safeLink}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#0b74ff;color:#fff;text-decoration:none;font-weight:700">Verify this device</a>`
    : `<span style="display:inline-block;padding:10px 14px;border-radius:10px;background:#bbb;color:#fff;font-weight:700">Verify this device (missing link)</span>`;

  return {
    subject,
    text: lines.join("\n"),
    html: `
<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.4;color:#111">
  <p><b>You signed in as a PerkValet administrator.</b></p>
  <p>To enable this computer for admin actions, click the button below:</p>
  <p style="margin:18px 0">${buttonHtml}</p>
  ${link ? `<p style="margin:12px 0"><a href="${safeLink}">${safeLink}</a></p>` : ""}
  <p style="color:#444">After verification, you'll return to: <code>${safeReturnTo}</code></p>
  <p style="color:#666;font-size:12px;margin-top:18px">If you did not request this, you can ignore this email.</p>
  ${toEmail ? `<p style="color:#888;font-size:12px;margin-top:10px">Sent to: ${escHtml(toEmail)}</p>` : ""}
</div>
`.trim(),
  };
};
