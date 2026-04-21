/**
 * merchant.capabilities.js — Feature capability matrix
 *
 * Based on teamSetupMode, determines which features are available.
 * Never show a broken/empty feature — hide it with explanation.
 *
 * Modes:
 *   individual — each employee has own POS login (full features)
 *   shared     — everyone shares one register login (store-level only)
 *   solo       — owner runs register alone (store-level only)
 *   external   — team managed in separate system (manual tracking)
 *   null       — not yet configured (show setup prompt)
 */

"use strict";

const CAPABILITIES = {
  individual: {
    associateAttribution: true,
    associateLeaderboard: true,
    associateCounterDisplay: true,
    teamReports: "full",
    nightlySync: true,
    welcomeEmails: true,
    description: "Full per-associate tracking — leaderboard, attribution, counter display",
  },
  shared: {
    associateAttribution: false,
    associateLeaderboard: false,
    associateCounterDisplay: false,
    teamReports: "store_only",
    nightlySync: false,
    welcomeEmails: true,
    description: "Store-level tracking only — shared register login prevents per-associate identification",
    upgradeMessage: "Switch to individual register logins to unlock per-associate tracking and the staff leaderboard.",
  },
  solo: {
    associateAttribution: false,
    associateLeaderboard: false,
    associateCounterDisplay: false,
    teamReports: "store_only",
    nightlySync: false,
    welcomeEmails: false,
    description: "Single operator — all transactions attributed to you",
    upgradeMessage: "Add team members in Settings → Team when you hire staff.",
  },
  external: {
    associateAttribution: true,
    associateLeaderboard: true,
    associateCounterDisplay: true,
    teamReports: "full",
    nightlySync: false,
    welcomeEmails: true,
    description: "Manual team tracking — add team members in Settings → Team",
  },
};

/**
 * Get feature capabilities for a merchant.
 * @param {string|null} teamSetupMode
 * @returns {{ features, mode, configured, description, upgradeMessage? }}
 */
function getMerchantCapabilities(teamSetupMode) {
  if (!teamSetupMode) {
    return {
      mode: null,
      configured: false,
      features: CAPABILITIES.shared, // default to limited until configured
      description: "Team setup not yet configured. Set up your team in Settings to unlock associate features.",
      setupRequired: true,
    };
  }

  const caps = CAPABILITIES[teamSetupMode] || CAPABILITIES.shared;
  return {
    mode: teamSetupMode,
    configured: true,
    features: caps,
    description: caps.description,
    upgradeMessage: caps.upgradeMessage || null,
    setupRequired: false,
  };
}

module.exports = { getMerchantCapabilities, CAPABILITIES };
