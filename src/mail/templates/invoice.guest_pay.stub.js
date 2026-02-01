// backend/src/mail/templates/invoice.guest_pay.stub.js
// Mail-Web-1: invoice email stub for Guest Pay link.
// DEV-first plain text. ASCII-only.

function render(data, helpers) {
  const h = helpers;
  const merchant = h.safeString(data.merchantName || "Merchant");
  const invoiceId = h.safeString(data.externalInvoiceId || data.invoiceId || "");
  const due = h.moneyFromCents(data.amountDueCents);
  const expiresAt = h.safeString(data.expiresAt || "");
  const payUrl = h.safeString(data.payUrl || "");

  return {
    subject: `Invoice ${invoiceId} from ${merchant}`,
    text:
`Hello,

An invoice is ready for payment.

Merchant: ${merchant}
Invoice: ${invoiceId}
Amount due: ${due}

Pay here:
${payUrl}

Link expires:
${expiresAt}

(DEV stub: this email is written to .dev/mail and not sent externally.)
`,
  };
}

module.exports = { render };
