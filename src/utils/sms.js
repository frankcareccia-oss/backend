// src/utils/sms.js
//
// SMS provider abstraction — mirrors the mail provider pattern.
// Set SMS_PROVIDER=console | twilio in .env
// Twilio requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

"use strict";

const PROVIDER = process.env.SMS_PROVIDER || "console";

async function sendSms({ to, body }) {
  if (PROVIDER === "twilio") {
    const twilio = require("twilio");
    const client = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    await client.messages.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      body,
    });
    return;
  }

  // console fallback — logs to terminal, never sends a real SMS
  console.log(`[sms:console] TO=${to} BODY="${body}"`);
}

module.exports = { sendSms };
