// backend/src/db/prisma.js
require("dotenv").config();

const { Pool } = require("pg");
const { PrismaClient } = require("@prisma/client");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = new Pool({ connectionString });

const prisma = new PrismaClient();

module.exports = {
  prisma,
  pool,
};
