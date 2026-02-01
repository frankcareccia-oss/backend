// backend/src/mail/templates/invoice.payment_succeeded.stub.js
// Mail-Web-1: payment succeeded email stub.
// DEV-first plain text. ASCII-only.

function render(data, helpers) {
  const h = helpers;
  const invoiceId = h.safeString(data.invoiceId || "(unlinked)");
  const amount = h.moneyFromCents(data.amountCents);
  const payer = h.safeString(data.payerEmail || "");
  const charge = h.safeString(data.providerChargeId || "");

  return {
    subject: `Payment received for invoice ${invoiceId}`,
    text:
`Hello,

Payment succeeded.

Invoice: ${invoiceId}
Amount: ${amount}
Payer: ${payer}
Provider charge id: ${charge}

(DEV stub: this email is written to .dev/mail and not sent externally.)
`,
  };
}

module.exports = { render };
