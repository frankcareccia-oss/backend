const { parsePhoneNumberFromString } = require("libphonenumber-js");

/**
 * Normalize a phone number to E.164.
 * Defaults to US (+1) if no country code is provided.
 */
function normalizePhone(input, defaultCountry = "US") {
  if (!input || typeof input !== "string") {
    throw new Error("Phone number is required");
  }

  const raw = input.trim();
  const phone = parsePhoneNumberFromString(raw, defaultCountry);

  if (!phone || !phone.isValid()) {
    throw new Error("Invalid phone number");
  }

  return {
    raw,
    e164: phone.number,
    country: phone.country || defaultCountry,
  };
}

module.exports = { normalizePhone };
