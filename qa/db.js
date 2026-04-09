/**
 * qa/db.js — Shared Postgres pool for the QA tracker database.
 */

"use strict";

const { Pool } = require("pg");

const pool = new Pool({
  host: "localhost",
  port: 5432,
  user: "perkvalet",
  password: "perkvalet",
  database: "perkvalet_qa",
});

module.exports = pool;
