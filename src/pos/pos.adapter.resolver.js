/**
 * pos.adapter.resolver.js — Factory: resolve the correct PVPosAdapter for a merchant.
 *
 * Usage:
 *   const adapter = await getPosAdapter(merchant);  // merchant must have .id
 *   const ctx = await adapter.getStoreContext(storeId);
 */

const { PrismaClient } = require("@prisma/client");
const { SquareAdapter } = require("./adapters/square.adapter");
const { CloverAdapter } = require("./adapters/clover.adapter");
const { ToastAdapter } = require("./adapters/toast.adapter");

const prisma = new PrismaClient();

/**
 * Look up the active PosConnection for this merchant and return the right adapter.
 *
 * @param {{ id: number }} merchant
 * @param {string} [posType] — override to select a specific POS type when multiple exist
 * @returns {Promise<PVPosAdapter>}
 */
async function getPosAdapter(merchant, posType) {
  const where = { merchantId: merchant.id, status: "active" };
  if (posType) where.posType = posType;

  const connection = await prisma.posConnection.findFirst({ where });

  if (!connection) {
    throw new Error(`No active POS connection found for merchant ${merchant.id}`);
  }

  switch (connection.posType) {
    case "square":
      return new SquareAdapter(connection);

    case "clover":
      return new CloverAdapter(connection);

    case "toast":
      return new ToastAdapter(connection);

    default:
      throw new Error(`Unsupported posType: ${connection.posType}`);
  }
}

module.exports = { getPosAdapter };
