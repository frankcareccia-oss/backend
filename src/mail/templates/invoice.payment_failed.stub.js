// backend/src/mail/templates/invoice.payment_failed.stub.js
// Mail-Web-1: payment failed email stub.
// DEV-first plain text. ASCII-only.

function render(data, helpers) {
  const h = helpers;
  const invoiceId = h.safeString(data.invoiceId || "(unlinked)");
  const payer = h.safeString(data.payerEmail || "");
  const charge = h.safeString(data.providerChargeId || "");

  return {
    subject: `Payment failed for invoice ${invoiceId}`,
    text:
`Hello,

Payment failed.

Invoice: ${invoiceId}
Payer: ${payer}
Provider charge id: ${charge}

(DEV stub: this email is written to .dev/mail and not sent externally.)
`,
  };
}

module.exports = { render };
