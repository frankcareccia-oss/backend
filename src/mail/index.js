// backend/src/mail/index.js
// Public surface area for mail domain.

const { sendMail, MAIL_CATEGORIES } = require("./mail.adapter");
const { pvMailHook } = require("./mail.hooks");
const { renderTemplate } = require("./templateRegistry");

module.exports = {
  sendMail,
  MAIL_CATEGORIES,
  pvMailHook,
  renderTemplate,
};
