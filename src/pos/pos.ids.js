// src/pos/pos.ids.js
// Stable ID generation for POS persistence (ULID-based)

const { ulid } = require("ulid");

function eventId() {
  return `evt_${ulid()}`;
}

function visitId() {
  return `vis_${ulid()}`;
}

function rewardId() {
  return `rew_${ulid()}`;
}

module.exports = {
  eventId,
  visitId,
  rewardId,
};
