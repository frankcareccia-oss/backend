/**
 * qa/server.js — QA Dashboard web app.
 *
 * Run:  node qa/server.js
 * Open: http://localhost:4100
 */

"use strict";

const express = require("express");
const { execFile, spawn } = require("child_process");
const path = require("path");
const http = require("http");
const pool = require("./db");

const BACKEND_DIR = path.resolve(__dirname, "..");
const BACKEND_PORT = 3001;

const app = express();
const PORT = 4100;

// ── Backend server management ────────────────────────

let backendProc = null;
let backendLogs = [];
const MAX_LOG_LINES = 200;

function addLog(line) {
  backendLogs.push({ ts: new Date().toISOString(), line });
  if (backendLogs.length > MAX_LOG_LINES) backendLogs.shift();
}

function startBackend() {
  if (backendProc) return { ok: false, message: "Already running" };

  backendProc = spawn("node", ["index.js"], {
    cwd: BACKEND_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  backendProc.stdout.on("data", (d) => {
    d.toString().split("\n").filter(Boolean).forEach((l) => addLog(l));
  });
  backendProc.stderr.on("data", (d) => {
    d.toString().split("\n").filter(Boolean).forEach((l) => addLog("[ERR] " + l));
  });

  backendProc.on("exit", (code) => {
    addLog("Process exited with code " + code);
    backendProc = null;
  });

  addLog("Backend server starting on port " + BACKEND_PORT);
  return { ok: true, message: "Starting..." };
}

function stopBackend() {
  // If we manage the process, kill it directly
  if (backendProc) {
    backendProc.kill("SIGTERM");
    addLog("Sent SIGTERM to managed backend");
    const proc = backendProc;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill("SIGKILL");
        addLog("Force killed managed backend");
      }
    }, 3000);
    backendProc = null;
    return { ok: true, message: "Stopping..." };
  }

  // Otherwise, find and kill whatever is on the backend port
  try {
    const { execSync } = require("child_process");
    const out = execSync("netstat -ano | findstr :" + BACKEND_PORT + " | findstr LISTEN", { encoding: "utf8" });
    const match = out.match(/LISTENING\s+(\d+)/);
    if (match) {
      const pid = match[1];
      execSync("taskkill /F /PID " + pid);
      addLog("Killed external process on port " + BACKEND_PORT + " (PID " + pid + ")");
      return { ok: true, message: "Stopped PID " + pid };
    }
  } catch (_) {}

  return { ok: false, message: "No process found on port " + BACKEND_PORT };
}

function checkBackendAlive() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: BACKEND_PORT, path: "/", method: "GET", timeout: 2000 },
      (res) => { res.resume(); resolve(true); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

app.use(express.json());

// ── API ──────────────────────────────────────────────

// All cases (with optional status filter)
app.get("/api/cases", async (req, res) => {
  const { status } = req.query;
  let sql = "SELECT * FROM qa_cases";
  const params = [];
  if (status) {
    sql += " WHERE status = $1";
    params.push(status);
  }
  sql += " ORDER BY case_number ASC";
  const { rows } = await pool.query(sql, params);
  res.json(rows);
});

// Single case with its run history
app.get("/api/cases/:id", async (req, res) => {
  const { rows: caseRows } = await pool.query(
    "SELECT * FROM qa_cases WHERE id = $1", [req.params.id]
  );
  if (!caseRows.length) return res.status(404).json({ error: "Not found" });

  const { rows: history } = await pool.query(
    `SELECT rr.*, r.ran_at
     FROM qa_run_results rr
     JOIN qa_runs r ON r.id = rr.run_id
     WHERE rr.case_id = $1
     ORDER BY r.ran_at DESC`,
    [req.params.id]
  );
  res.json({ ...caseRows[0], history });
});

// Update case status (manual override)
app.patch("/api/cases/:id", async (req, res) => {
  const { status, notes } = req.body;
  const sets = [];
  const params = [];
  let idx = 1;

  if (status) {
    sets.push(`status = $${idx++}`);
    params.push(status);
    if (status === "fixed") {
      sets.push(`fixed_at = NOW()`);
    } else if (status === "verified") {
      sets.push(`verified_at = NOW()`);
    }
  }
  if (notes !== undefined) {
    sets.push(`notes = $${idx++}`);
    params.push(notes);
  }

  if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

  params.push(req.params.id);
  const sql = `UPDATE qa_cases SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`;
  const { rows } = await pool.query(sql, params);
  res.json(rows[0]);
});

// All runs
app.get("/api/runs", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM qa_runs ORDER BY ran_at DESC LIMIT 50");
  res.json(rows);
});

// Summary stats
app.get("/api/summary", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'open') AS open,
      COUNT(*) FILTER (WHERE status = 'fixed') AS fixed,
      COUNT(*) FILTER (WHERE status = 'verified') AS verified,
      COUNT(*) FILTER (WHERE status = 'regressed') AS regressed,
      COUNT(*) AS total
    FROM qa_cases
  `);
  const lastRun = await pool.query("SELECT * FROM qa_runs ORDER BY ran_at DESC LIMIT 1");
  res.json({ cases: rows[0], lastRun: lastRun.rows[0] || null });
});

// Run tests from the UI
let runInProgress = false;

app.post("/api/run", async (req, res) => {
  if (runInProgress) return res.status(409).json({ error: "A test run is already in progress" });

  const { scope, caseIds } = req.body || {};  // "all" | "fixed" | "cases"
  runInProgress = true;

  let filter = "";
  if (scope === "fixed") {
    const { rows } = await pool.query(
      "SELECT DISTINCT test_file FROM qa_cases WHERE status = 'fixed'"
    );
    if (rows.length === 0) {
      runInProgress = false;
      return res.json({ skipped: true, message: "No fixed cases to test" });
    }
    const patterns = rows.map(r => r.test_file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    filter = patterns.join("|");
  } else if (scope === "cases" && Array.isArray(caseIds) && caseIds.length) {
    const { rows } = await pool.query(
      "SELECT DISTINCT test_file FROM qa_cases WHERE id = ANY($1::int[])",
      [caseIds]
    );
    if (rows.length === 0) {
      runInProgress = false;
      return res.json({ skipped: true, message: "No matching cases found" });
    }
    const patterns = rows.map(r => r.test_file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    filter = patterns.join("|");
  }

  const args = [path.join(__dirname, "track.js")];
  if (filter) args.push(filter);

  res.json({ started: true, scope: scope || "all" });

  execFile("node", args, { cwd: BACKEND_DIR, timeout: 300000 }, (err, stdout, stderr) => {
    runInProgress = false;
    if (err && !stdout) {
      console.error("Test run failed:", stderr?.slice(0, 500));
    } else {
      console.log(stdout);
    }
  });
});

app.get("/api/run/status", (_req, res) => {
  res.json({ running: runInProgress });
});

// ── Server management API ────────────────────────────

app.get("/api/server/status", async (_req, res) => {
  const alive = await checkBackendAlive();
  res.json({
    running: alive,
    managed: backendProc !== null,
    port: BACKEND_PORT,
  });
});

app.post("/api/server/start", (_req, res) => {
  res.json(startBackend());
});

app.post("/api/server/stop", (_req, res) => {
  res.json(stopBackend());
});

app.post("/api/server/restart", async (_req, res) => {
  stopBackend();
  // Wait for port to free up
  setTimeout(() => {
    res.json(startBackend());
  }, 1500);
});

app.get("/api/server/logs", (_req, res) => {
  res.json(backendLogs.slice(-50));
});

// ── Frontend ─────────────────────────────────────────

app.get("/", (_req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PerkValet QA Tracker</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1117; color: #e1e4e8; display: flex; flex-direction: column; }

  .top-fixed { flex-shrink: 0; background: #0f1117; z-index: 10; }

  .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
  .header h1 { font-size: 20px; font-weight: 600; }
  .header h1 span { color: #58a6ff; }
  .header-actions { display: flex; gap: 8px; align-items: center; }

  .server-bar { background: #0d1117; border-bottom: 1px solid #30363d; padding: 8px 24px; display: flex; align-items: center; gap: 12px; font-size: 13px; }
  .server-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .server-dot.on { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .server-dot.off { background: #f85149; box-shadow: 0 0 6px #f85149; }
  .server-dot.checking { background: #d29922; animation: pulse 1s infinite; }
  .server-label { color: #8b949e; }
  .server-status-text { font-weight: 600; }
  .server-status-text.on { color: #3fb950; }
  .server-status-text.off { color: #f85149; }
  .server-btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .server-btn:hover { background: #30363d; }
  .server-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .server-btn.start { border-color: #238636; color: #3fb950; }
  .server-btn.stop { border-color: #da3633; color: #f85149; }
  .server-btn.restart { border-color: #d29922; color: #d29922; }
  .server-port { color: #8b949e; font-family: monospace; font-size: 12px; }

  .run-dropdown { position: relative; display: inline-block; }
  .run-btn { background: #238636; border: 1px solid #2ea043; color: #fff; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .run-btn:hover { background: #2ea043; }
  .run-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .run-btn .arrow { font-size: 10px; }
  .run-menu { display: none; position: absolute; right: 0; top: 100%; margin-top: 4px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; z-index: 50; min-width: 200px; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .run-menu.show { display: block; }
  .run-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: #c9d1d9; padding: 10px 16px; cursor: pointer; font-size: 13px; }
  .run-menu button:hover { background: #21262d; }
  .run-menu button .hint { display: block; font-size: 11px; color: #8b949e; margin-top: 2px; }

  .run-status { font-size: 12px; color: #d29922; display: none; align-items: center; gap: 6px; }
  .run-status.show { display: flex; }
  .spinner { width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #d29922; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .summary { display: flex; gap: 16px; padding: 20px 24px; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px 20px; min-width: 130px; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 12px; color: #8b949e; text-transform: uppercase; margin-top: 4px; }
  .stat.open .num { color: #f85149; }
  .stat.fixed .num { color: #d29922; }
  .stat.verified .num { color: #3fb950; }
  .stat.regressed .num { color: #f0883e; }

  .controls { padding: 0 24px 12px; display: flex; gap: 8px; align-items: center; }
  .controls button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .controls button:hover { background: #30363d; }
  .controls button.active { background: #388bfd26; border-color: #388bfd; color: #58a6ff; }

  .table-wrap { flex: 1; overflow-y: auto; overflow-x: auto; padding: 0 24px 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead { position: sticky; top: 0; background: #0f1117; z-index: 5; }
  th { text-align: left; padding: 10px 12px; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 11px; }
  td { padding: 10px 12px; border-bottom: 1px solid #21262d; vertical-align: top; }
  tr:hover { background: #161b22; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.open { background: #f8514926; color: #f85149; }
  .badge.fixed { background: #d2992226; color: #d29922; }
  .badge.verified { background: #3fb95026; color: #3fb950; }
  .badge.regressed { background: #f0883e26; color: #f0883e; }

  .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 500; background: #21262d; color: #8b949e; }
  .tag.auth { background: #da3633aa; color: #fff; }
  .tag.catalog { background: #1f6feb; color: #fff; }
  .tag.promotions { background: #8957e5; color: #fff; }
  .tag.consumer { background: #238636; color: #fff; }
  .tag.growth { background: #d29922; color: #000; }
  .tag.payments { background: #f0883e; color: #000; }
  .tag.pos { background: #3fb950; color: #000; }
  .tag.integrations { background: #388bfd; color: #fff; }

  .filter-select { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .filter-select:focus { outline: none; border-color: #388bfd; }

  .tree { padding: 0 24px 24px; }
  .tree-repo { margin-bottom: 8px; }
  .tree-repo-header { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 4px; cursor: pointer; }
  .tree-repo-header:hover { background: #1c2128; }
  .tree-repo-name { font-size: 15px; font-weight: 700; color: #c9d1d9; }
  .tree-repo-stats { font-size: 12px; color: #8b949e; margin-left: auto; }
  .tree-repo-run { background: #238636; border: 1px solid #2ea043; color: #fff; padding: 3px 10px; border-radius: 5px; font-size: 11px; font-weight: 600; cursor: pointer; }
  .tree-repo-run:hover { background: #2ea043; }
  .tree-repo-run.running { background: #d29922; border-color: #d29922; animation: pulse 0.8s ease-in-out infinite; }

  .tree-cat { margin-left: 16px; margin-bottom: 2px; }
  .tree-cat-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
  .tree-cat-header:hover { background: #161b22; }
  .tree-arrow { color: #484f58; font-size: 10px; width: 14px; text-align: center; transition: transform 0.15s; }
  .tree-arrow.open { transform: rotate(90deg); }
  .tree-cat-name { font-size: 13px; font-weight: 600; color: #c9d1d9; }
  .tree-cat-badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
  .tree-cat-badge.all-pass { background: #3fb95026; color: #3fb950; }
  .tree-cat-badge.has-fail { background: #f8514926; color: #f85149; }
  .tree-cat-stats { font-size: 11px; color: #8b949e; margin-left: auto; }
  .tree-cat-run { background: #21262d; border: 1px solid #30363d; color: #3fb950; padding: 2px 8px; border-radius: 5px; font-size: 11px; cursor: pointer; }
  .tree-cat-run:hover { background: #30363d; }
  .tree-cat-run.running { color: #d29922; border-color: #d29922; animation: pulse 0.8s ease-in-out infinite; }

  .tree-cases { margin-left: 38px; display: none; }
  .tree-cases.open { display: block; }
  .tree-case { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-size: 12px; border-bottom: 1px solid #21262d; }
  .tree-case:hover { background: #161b22; }
  .tree-case-num { color: #58a6ff; font-weight: 600; cursor: pointer; min-width: 70px; }
  .tree-case-num:hover { text-decoration: underline; }
  .tree-case-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .tree-case-dot.pass { background: #3fb950; }
  .tree-case-dot.fail { background: #f85149; }
  .tree-case-dot.fixed { background: #d29922; }
  .tree-case-name { color: #c9d1d9; flex: 1; }
  .tree-case-file { color: #484f58; font-size: 11px; }

  .case-num { color: #58a6ff; font-weight: 600; cursor: pointer; }
  .case-num:hover { text-decoration: underline; }
  .run-icon { color: #3fb950; cursor: pointer; font-size: 15px; opacity: 0.6; transition: all 0.3s; }
  .run-icon:hover { opacity: 1; }
  .run-icon.running { color: #d29922; opacity: 1; animation: pulse 0.8s ease-in-out infinite; cursor: default; }
  .run-icon.done { color: #3fb950; opacity: 1; animation: flash 0.4s ease-in-out 3; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  @keyframes flash { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
  .file { color: #8b949e; }
  .error-preview { color: #f85149; font-family: monospace; font-size: 12px; max-width: 500px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .time { color: #8b949e; font-size: 12px; }

  /* Detail modal */
  .modal-bg { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 100; }
  .modal-bg.show { display: flex; align-items: center; justify-content: center; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; max-width: 800px; width: 90%; max-height: 80vh; overflow-y: auto; padding: 24px; }
  .modal h2 { margin-bottom: 12px; font-size: 16px; }
  .modal .meta { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .modal .meta span { font-size: 12px; color: #8b949e; }
  .modal pre { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-size: 12px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: #f85149; margin-bottom: 16px; max-height: 300px; overflow-y: auto; }
  .modal .actions { display: flex; gap: 8px; margin-top: 12px; }
  .modal .actions button { padding: 6px 16px; border-radius: 6px; border: 1px solid #30363d; cursor: pointer; font-size: 13px; }
  .modal .btn-fixed { background: #d29922; color: #000; border-color: #d29922; }
  .modal .btn-close { background: #21262d; color: #c9d1d9; }
  .modal .history { margin-top: 16px; }
  .modal .history h3 { font-size: 13px; color: #8b949e; margin-bottom: 8px; }
  .modal .history-item { font-size: 12px; padding: 4px 0; border-bottom: 1px solid #21262d; display: flex; gap: 12px; }
  .modal .history-item .h-status { font-weight: 600; }
  .modal .history-item .h-status.passed { color: #3fb950; }
  .modal .history-item .h-status.failed { color: #f85149; }
</style>
</head>
<body>
  <div class="top-fixed">
    <div class="header">
      <h1><span>PerkValet</span> QA Tracker</h1>
      <div class="header-actions">
        <div class="run-status" id="runStatus">
          <div class="spinner"></div>
          <span id="runStatusText">Running tests...</span>
        </div>
        <div class="run-dropdown">
          <button class="run-btn" id="runBtn" onclick="toggleRunMenu()">Run Tests <span class="arrow">&#9662;</span></button>
          <div class="run-menu" id="runMenu">
            <button onclick="syncResults()">
              Sync Results
              <span class="hint">Run suite &amp; update tracker</span>
            </button>
            <button onclick="runTests('fixed')">
              Run Fixed Only
              <span class="hint">Re-test cases marked as fixed</span>
            </button>
          </div>
        </div>
        <button onclick="refreshDashboard()" style="background:#30363d;border:1px solid #484f58;color:#e1e4e8;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;transition:background 0.2s" onmouseover="this.style.background='#484f58'" onmouseout="this.style.background='#30363d'">Refresh</button>
      </div>
    </div>

    <div class="server-bar">
      <span class="server-dot checking" id="serverDot"></span>
      <span class="server-label">PV API</span>
      <span class="server-status-text" id="serverStatusText">Checking...</span>
      <span class="server-port" id="serverPort"></span>
      <button class="server-btn start" id="btnStart" onclick="serverAction('start')" disabled>Start</button>
      <button class="server-btn stop" id="btnStop" onclick="serverAction('stop')" disabled>Stop</button>
      <button class="server-btn restart" id="btnRestart" onclick="serverAction('restart')" disabled>Restart</button>
    </div>

    <div class="summary" id="summary"></div>

    <div class="controls">
      <span style="color:#8b949e;font-size:13px">Repo:</span>
      <select class="filter-select" id="repoFilter" onchange="onRepoFilter()">
        <option value="all">All Repos</option>
      </select>
      <span style="color:#30363d;margin:0 4px">|</span>
      <span style="color:#8b949e;font-size:13px">Feature:</span>
      <select class="filter-select" id="featureFilter" onchange="onFeatureFilter()">
        <option value="all">All Features</option>
      </select>
      <span style="color:#30363d;margin:0 16px"></span>
      <span style="color:#8b949e;font-size:13px">Status:</span>
      <button class="active" data-filter="all">All</button>
      <button data-filter="open">Open</button>
      <button data-filter="fixed">Fixed</button>
      <button data-filter="verified">Verified</button>
      <button data-filter="regressed">Regressed</button>
    </div>
  </div>

  <div class="tree" id="treeContainer"></div>

  <div class="modal-bg" id="modalBg" onclick="if(event.target===this)closeModal()">
    <div class="modal" id="modal"></div>
  </div>

<script>
let allCases = [];
let currentFilter = "all";
let currentFeature = "all";
let currentRepo = "all";
let currentView = "flat";
let expandedNodes = new Set();

async function refreshDashboard() {
  const [sumRes, casesRes] = await Promise.all([
    fetch("/api/summary").then(r => r.json()),
    fetch("/api/cases").then(r => r.json()),
  ]);
  allCases = casesRes;
  renderSummary(sumRes);
  populateFilterDropdowns();
  renderCases();
}

const ALL_REPOS = ["backend", "admin", "consumer-app"];

function populateFilterDropdowns() {
  const rSel = document.getElementById("repoFilter");
  rSel.innerHTML = '<option value="all">All Repos</option>' + ALL_REPOS.map(r => '<option value="' + r + '"' + (r === currentRepo ? ' selected' : '') + '>' + r + '</option>').join("");
  populateFeatureDropdown();
}

function populateFeatureDropdown() {
  const filtered = currentRepo === "all" ? allCases : allCases.filter(c => c.repo === currentRepo);
  const features = [...new Set(filtered.map(c => c.feature))].sort();
  const fSel = document.getElementById("featureFilter");
  fSel.innerHTML = '<option value="all">All Features</option>' + features.map(f => '<option value="' + f + '"' + (f === currentFeature ? ' selected' : '') + '>' + f + '</option>').join("");
  // Reset feature if current selection no longer exists in filtered set
  if (currentFeature !== "all" && !features.includes(currentFeature)) {
    currentFeature = "all";
  }
}

function onFeatureFilter() { currentFeature = document.getElementById("featureFilter").value; renderCases(); }
function onRepoFilter() { currentRepo = document.getElementById("repoFilter").value; currentFeature = "all"; populateFeatureDropdown(); renderCases(); }

function renderSummary(s) {
  const c = s.cases;
  const run = s.lastRun;
  document.getElementById("summary").innerHTML =
    stat("open", c.open, "Open") +
    stat("regressed", c.regressed, "Regressed") +
    stat("fixed", c.fixed, "Fixed") +
    stat("verified", c.verified, "Verified") +
    stat("", c.total, "Total Cases") +
    (run ? '<div class="stat"><div class="num" style="font-size:16px">' +
      new Date(run.ran_at).toLocaleString() +
      '</div><div class="label">Last Run (#' + run.id + ') — ' +
      run.passed + ' pass / ' + run.failed + ' fail' +
      (run.git_commit ? '<br>' + run.git_branch + ' @ ' + run.git_commit : '') +
      '</div></div>' : '');
}

function stat(cls, num, label) {
  return '<div class="stat ' + cls + '"><div class="num">' + num + '</div><div class="label">' + label + '</div></div>';
}

function renderCases() {
  let filtered = allCases;
  if (currentFilter !== "all") filtered = filtered.filter(c => c.status === currentFilter);
  if (currentFeature !== "all") filtered = filtered.filter(c => c.feature === currentFeature);
  if (currentRepo !== "all") filtered = filtered.filter(c => c.repo === currentRepo);

  renderTree(filtered);
}

function renderTree(cases) {
  // Build structure: repo → feature → cases
  const repos = {};
  cases.forEach(c => {
    const r = c.repo || "unknown";
    const f = c.feature || "other";
    if (!repos[r]) repos[r] = {};
    if (!repos[r][f]) repos[r][f] = [];
    repos[r][f].push(c);
  });

  const container = document.getElementById("treeContainer");
  let html = "";

  const repoOrder = Object.keys(repos).sort();
  for (const repo of repoOrder) {
    const features = repos[repo];
    const featureOrder = Object.keys(features).sort();

    const repoTotal = featureOrder.reduce((s, f) => s + features[f].length, 0);
    const repoPass = featureOrder.reduce((s, f) => s + features[f].filter(c => c.status === "verified").length, 0);
    const repoAllPass = repoPass === repoTotal;
    const repoId = "repo-" + repo.replace(/[^a-z0-9]/gi, "_");

    html += '<div class="tree-repo">';
    html += '<div class="tree-repo-header" onclick="toggleRepo(&apos;' + repoId + '&apos;)">';
    html += '<span class="tree-arrow" id="arrow-' + repoId + '">&#9654;</span>';
    html += '<span class="tree-repo-name">' + esc(repo) + '</span>';
    html += '<span class="tree-cat-badge ' + (repoAllPass ? "all-pass" : "has-fail") + '">' + repoPass + '/' + repoTotal + '</span>';
    html += '<span class="tree-repo-stats">' + featureOrder.length + ' features</span>';
    html += '<button class="tree-repo-run" onclick="event.stopPropagation(); runRepo(&apos;' + esc(repo) + '&apos;)" title="Run all ' + repo + ' tests">&#9654; Run</button>';
    html += '</div>';
    html += '<div id="' + repoId + '" style="display:none">';

    for (const feature of featureOrder) {
      const fCases = features[feature];
      const fPass = fCases.filter(c => c.status === "verified").length;
      const fTotal = fCases.length;
      const fAllPass = fPass === fTotal;
      const catId = repoId + "-" + feature.replace(/[^a-z0-9]/gi, "_");

      html += '<div class="tree-cat">';
      html += '<div class="tree-cat-header" onclick="toggleCat(&apos;' + catId + '&apos;)">';
      html += '<span class="tree-arrow" id="arrow-' + catId + '">&#9654;</span>';
      html += '<span class="tag ' + feature + '">' + feature + '</span>';
      html += '<span class="tree-cat-badge ' + (fAllPass ? "all-pass" : "has-fail") + '">' + fPass + '/' + fTotal + '</span>';
      html += '<button class="tree-cat-run" onclick="event.stopPropagation(); runCategory(&apos;' + esc(repo) + '&apos;,&apos;' + esc(feature) + '&apos;)" title="Run ' + feature + ' tests">&#9654;</button>';
      html += '</div>';
      html += '<div class="tree-cases" id="' + catId + '">';

      for (const c of fCases) {
        const dotClass = c.status === "verified" ? "pass" : c.status === "fixed" ? "fixed" : "fail";
        html += '<div class="tree-case">';
        html += '<span class="tree-case-dot ' + dotClass + '"></span>';
        html += '<span class="tree-case-num" onclick="showDetail(' + c.id + ')">' + c.case_number + '</span>';
        html += '<span class="tree-case-name">' + esc(c.test_name) + '</span>';
        html += '<span class="tree-case-file">' + esc(c.test_file) + '</span>';
        html += '</div>';
      }

      html += '</div></div>';
    }

    html += '</div></div>';
  }

  container.innerHTML = html;

  // Restore expanded state
  for (const id of expandedNodes) {
    const el = document.getElementById(id);
    const arrow = document.getElementById("arrow-" + id);
    if (el && arrow) {
      if (el.classList.contains("tree-cases")) {
        el.classList.add("open");
      } else {
        el.style.display = "block";
      }
      arrow.classList.add("open");
    }
  }
}

function toggleRepo(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById("arrow-" + id);
  if (el.style.display === "none") {
    el.style.display = "block";
    arrow.classList.add("open");
    expandedNodes.add(id);
  } else {
    el.style.display = "none";
    arrow.classList.remove("open");
    expandedNodes.delete(id);
  }
}

function toggleCat(id) {
  const el = document.getElementById(id);
  const arrow = document.getElementById("arrow-" + id);
  el.classList.toggle("open");
  arrow.classList.toggle("open");
  if (el.classList.contains("open")) expandedNodes.add(id);
  else expandedNodes.delete(id);
}

function runRepo(repo) {
  // Collect all case IDs for this repo
  const ids = allCases.filter(c => c.repo === repo).map(c => c.id);
  if (!ids.length) return;
  runCaseBatch(ids, "repo-" + repo.replace(/[^a-z0-9]/gi, "_"));
}

function runCategory(repo, feature) {
  const ids = allCases.filter(c => c.repo === repo && c.feature === feature).map(c => c.id);
  if (!ids.length) return;
  const catId = "repo-" + repo.replace(/[^a-z0-9]/gi, "_") + "-" + feature.replace(/[^a-z0-9]/gi, "_");
  runCaseBatch(ids, catId);
}

async function runCaseBatch(caseIds, uiId) {
  const runBtn = document.querySelector("#" + uiId + " .tree-cat-run") || document.querySelector("[onclick*='" + uiId + "'] .tree-repo-run");
  document.getElementById("runBtn").disabled = true;
  const status = document.getElementById("runStatus");
  const statusText = document.getElementById("runStatusText");
  status.classList.add("show");
  const startTime = Date.now();
  statusText.textContent = "Running " + caseIds.length + " tests... 0s";
  syncTimer = setInterval(() => {
    statusText.textContent = "Running " + caseIds.length + " tests... " + Math.round((Date.now() - startTime) / 1000) + "s";
  }, 1000);

  try {
    await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "cases", caseIds }),
    });
    pollRunStatus();
  } catch (err) {
    clearInterval(syncTimer);
    statusText.textContent = "Error";
    setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
  }
}

function firstLine(s) { return (s || "").split("\\n")[0].slice(0, 120); }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function shortDate(s) { return s ? new Date(s).toLocaleDateString() + " " + new Date(s).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "-"; }

async function showDetail(id) {
  const data = await fetch("/api/cases/" + id).then(r => r.json());
  const m = document.getElementById("modal");
  m.innerHTML =
    '<h2>' + data.case_number + ' — ' + data.test_name + '</h2>' +
    '<div class="meta">' +
      '<span>File: ' + data.test_file + '</span>' +
      '<span>Suite: ' + (data.suite_name || '-') + '</span>' +
      '<span>Status: <span class="badge ' + data.status + '">' + data.status + '</span></span>' +
    '</div>' +
    '<pre>' + esc(data.error_message || "No error") + '</pre>' +
    '<div class="actions">' +
      '<button style="background:#238636;color:#fff;border-color:#2ea043" onclick="runCase(' + id + ');closeModal()">Run This Test</button>' +
      (data.status === "open" || data.status === "regressed"
        ? '<button class="btn-fixed" onclick="markFixed(' + id + ')">Mark Fixed</button>' : '') +
      '<button class="btn-close" onclick="closeModal()">Close</button>' +
    '</div>' +
    '<div class="history"><h3>Run History</h3>' +
      (data.history || []).map(h =>
        '<div class="history-item">' +
          '<span class="h-status ' + h.status + '">' + h.status + '</span>' +
          '<span>' + shortDate(h.ran_at) + '</span>' +
          '<span>' + h.duration_ms + 'ms</span>' +
        '</div>'
      ).join("") +
    '</div>';
  document.getElementById("modalBg").classList.add("show");
}

async function markFixed(id) {
  await fetch("/api/cases/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "fixed" }),
  });
  closeModal();
  refreshDashboard();
}

function closeModal() {
  document.getElementById("modalBg").classList.remove("show");
}

// Filter buttons
document.querySelectorAll(".controls button[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".controls button[data-filter]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentFilter = btn.dataset.filter;
    renderCases();
  });
});

// Server management
async function checkServerStatus() {
  try {
    const data = await fetch("/api/server/status").then(r => r.json());
    const dot = document.getElementById("serverDot");
    const txt = document.getElementById("serverStatusText");
    const port = document.getElementById("serverPort");
    const btnStart = document.getElementById("btnStart");
    const btnStop = document.getElementById("btnStop");
    const btnRestart = document.getElementById("btnRestart");

    if (data.running) {
      dot.className = "server-dot on";
      txt.className = "server-status-text on";
      txt.textContent = "Running";
      port.textContent = ":" + data.port;
      btnStart.disabled = true;
      btnStop.disabled = false;
      btnRestart.disabled = false;
    } else {
      dot.className = "server-dot off";
      txt.className = "server-status-text off";
      txt.textContent = "Stopped";
      port.textContent = ":" + data.port;
      btnStart.disabled = false;
      btnStop.disabled = true;
      btnRestart.disabled = true;
    }
  } catch (e) {
    document.getElementById("serverDot").className = "server-dot off";
    document.getElementById("serverStatusText").textContent = "Error";
  }
}

async function serverAction(action) {
  document.getElementById("btnStart").disabled = true;
  document.getElementById("btnStop").disabled = true;
  document.getElementById("btnRestart").disabled = true;
  document.getElementById("serverDot").className = "server-dot checking";
  document.getElementById("serverStatusText").textContent = action === "start" ? "Starting..." : action === "stop" ? "Stopping..." : "Restarting...";

  await fetch("/api/server/" + action, { method: "POST" });
  // Poll until status settles
  setTimeout(checkServerStatus, 2000);
}

// Poll server status every 5 seconds
checkServerStatus();
setInterval(checkServerStatus, 5000);

// Run a single case
let runningCaseId = null;

async function runCase(id) {
  const icon = document.getElementById("run-icon-" + id);
  if (icon) { icon.classList.add("running"); icon.classList.remove("done"); }
  runningCaseId = id;

  document.getElementById("runBtn").disabled = true;
  const status = document.getElementById("runStatus");
  const statusText = document.getElementById("runStatusText");
  status.classList.add("show");
  statusText.textContent = "Running test...";
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "cases", caseIds: [id] }),
    });
    const data = await res.json();
    if (data.skipped) {
      statusText.textContent = data.message;
      if (icon) { icon.classList.remove("running"); }
      runningCaseId = null;
      setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
      return;
    }
    pollRunStatus(id);
  } catch (err) {
    statusText.textContent = "Error starting run";
    if (icon) { icon.classList.remove("running"); }
    runningCaseId = null;
    setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
  }
}


let syncTimer = null;

async function syncResults() {
  document.getElementById("runMenu").classList.remove("show");
  document.getElementById("runBtn").disabled = true;
  const status = document.getElementById("runStatus");
  const statusText = document.getElementById("runStatusText");
  status.classList.add("show");

  const startTime = Date.now();
  statusText.textContent = "Syncing... 0s";
  syncTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    statusText.textContent = "Syncing... " + elapsed + "s";
  }, 1000);

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "all" }),
    });
    const data = await res.json();
    if (data.skipped) {
      clearInterval(syncTimer);
      statusText.textContent = data.message;
      setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
      return;
    }
    pollRunStatus();
  } catch (err) {
    clearInterval(syncTimer);
    statusText.textContent = "Error syncing";
    setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
  }
}

// Run tests dropdown
function toggleRunMenu() {
  document.getElementById("runMenu").classList.toggle("show");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".run-dropdown")) {
    document.getElementById("runMenu").classList.remove("show");
  }
});

async function runTests(scope) {
  document.getElementById("runMenu").classList.remove("show");
  document.getElementById("runBtn").disabled = true;
  const status = document.getElementById("runStatus");
  const statusText = document.getElementById("runStatusText");
  status.classList.add("show");
  statusText.textContent = scope === "fixed" ? "Running fixed cases..." : "Running all tests...";

  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope }),
    });
    const data = await res.json();
    if (data.skipped) {
      statusText.textContent = data.message;
      setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
      return;
    }
    // Poll for completion
    pollRunStatus();
  } catch (err) {
    statusText.textContent = "Error starting run";
    setTimeout(() => { status.classList.remove("show"); document.getElementById("runBtn").disabled = false; }, 3000);
  }
}

function pollRunStatus(caseId) {
  const iv = setInterval(async () => {
    const res = await fetch("/api/run/status").then(r => r.json());
    if (!res.running) {
      clearInterval(iv);
      if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
      document.getElementById("runStatus").classList.remove("show");
      document.getElementById("runBtn").disabled = false;

      // Flash the icon green on completion
      const doneId = caseId || runningCaseId;
      if (doneId) {
        const icon = document.getElementById("run-icon-" + doneId);
        if (icon) { icon.classList.remove("running"); icon.classList.add("done"); }
        setTimeout(() => {
          if (icon) icon.classList.remove("done");
        }, 2000);
      }
      runningCaseId = null;

      refreshDashboard();
    }
  }, 2000);
}

refreshDashboard();
</script>
</body>
</html>`;

// ── Start ────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("QA Dashboard running at http://localhost:" + PORT);

  // Clean shutdown — stop backend when QA server exits
  function cleanup() {
    if (backendProc) {
      console.log("Stopping backend server...");
      backendProc.kill("SIGTERM");
    }
    process.exit(0);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
});
