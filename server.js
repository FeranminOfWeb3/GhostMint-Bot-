// server.js — MintBot API Server
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { deriveAddress, getBalance, getGas } = require("./mintEngine");
const {
  store, log,
  addWallet, getWallets, setWalletActive, removeWallet,
  createDrop, updateDrop, deleteDrop,
  createTask, cancelTask, fireNow,
  triggerRBF, pollGas, gasCache,
} = require("./jobQueue");

const app = express();
const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || "mintbot-secret";

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"],
}));
app.options("*", cors());
app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers["x-api-key"] || req.query.key;
  if (key !== API_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─── Health ───────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    wallets: store.wallets.length,
    drops: store.drops.length,
    tasks: store.tasks.length,
    runs: store.runs.length,
    scheduledJobs: Object.keys(store.scheduledJobs).length,
  });
});

// ─── Config / RPC key ────────────────────────────────────────
app.post("/config/rpc", auth, (req, res) => {
  const { rpcKey } = req.body;
  store.rpcKey = rpcKey || "";
  log("RPC key updated", "info");
  res.json({ ok: true });
});

app.get("/config", auth, (req, res) => {
  res.json({ rpcKeySet: !!store.rpcKey });
});

// ─── Wallets ──────────────────────────────────────────────────
app.get("/wallets", auth, (req, res) => res.json(getWallets()));

app.post("/wallets", auth, async (req, res) => {
  const { label, privateKey } = req.body;
  if (!privateKey) return res.status(400).json({ error: "privateKey required" });
  try {
    const address = deriveAddress(privateKey);
    const id = addWallet(label || `Wallet ${store.wallets.length + 1}`, privateKey, address);
    res.json({ id, address });
  } catch (e) {
    res.status(400).json({ error: "Invalid private key" });
  }
});

app.patch("/wallets/:id", auth, (req, res) => {
  const { active } = req.body;
  setWalletActive(req.params.id, active);
  res.json({ ok: true });
});

app.delete("/wallets/:id", auth, (req, res) => {
  removeWallet(req.params.id);
  res.json({ ok: true });
});

app.get("/wallets/:id/balance", auth, async (req, res) => {
  const w = store.wallets.find(w => w.id === req.params.id);
  if (!w) return res.status(404).json({ error: "Wallet not found" });
  try {
    const { chain } = req.query;
    const data = await getBalance(w.privateKey, chain || "eth", store.rpcKey);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Drops ────────────────────────────────────────────────────
app.get("/drops", auth, (req, res) => res.json(store.drops));

app.post("/drops", auth, (req, res) => {
  const drop = createDrop(req.body);
  res.json(drop);
});

app.put("/drops/:id", auth, (req, res) => {
  const drop = updateDrop(req.params.id, req.body);
  if (!drop) return res.status(404).json({ error: "Drop not found" });
  res.json(drop);
});

app.delete("/drops/:id", auth, (req, res) => {
  deleteDrop(req.params.id);
  res.json({ ok: true });
});

// ─── Tasks ────────────────────────────────────────────────────
app.get("/tasks", auth, (req, res) => {
  const { dropId } = req.query;
  const tasks = dropId ? store.tasks.filter(t => t.dropId === dropId) : store.tasks;
  res.json(tasks);
});

app.post("/tasks", auth, (req, res) => {
  const { dropId, name, scheduledAt } = req.body;
  if (!dropId) return res.status(400).json({ error: "dropId required" });
  const task = createTask(dropId, name, scheduledAt);
  res.json(task);
});

app.post("/tasks/:id/fire", auth, async (req, res) => {
  try {
    const run = await fireNow(req.params.id);
    res.json(run);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tasks/:id/cancel", auth, (req, res) => {
  const ok = cancelTask(req.params.id);
  res.json({ ok });
});

// ─── Runs ─────────────────────────────────────────────────────
app.get("/runs", auth, (req, res) => {
  const { dropId, taskId, limit } = req.query;
  let runs = store.runs;
  if (dropId) runs = runs.filter(r => r.dropId === dropId);
  if (taskId) runs = runs.filter(r => r.taskId === taskId);
  res.json(runs.slice(0, parseInt(limit) || 50));
});

app.get("/runs/:id", auth, (req, res) => {
  const run = store.runs.find(r => r.id === req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

// ─── PnL ──────────────────────────────────────────────────────
app.get("/pnl", auth, (req, res) => {
  const totalMints = store.pnl.length;
  const totalSpent = store.pnl.reduce((s, p) => s + p.mintPrice + p.gasCost, 0);
  const byDrop = {};
  store.pnl.forEach(p => {
    if (!byDrop[p.dropName]) byDrop[p.dropName] = { mints: 0, spent: 0 };
    byDrop[p.dropName].mints++;
    byDrop[p.dropName].spent += p.mintPrice + p.gasCost;
  });
  res.json({ totalMints, totalSpent: totalSpent.toFixed(6), byDrop, entries: store.pnl.slice(0, 100) });
});

// ─── Gas ──────────────────────────────────────────────────────
app.get("/gas/:chain", auth, async (req, res) => {
  try {
    const data = await pollGas(req.params.chain);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── RBF ──────────────────────────────────────────────────────
app.post("/rbf", auth, async (req, res) => {
  const { walletId, dropId, txHash } = req.body;
  const result = await triggerRBF(walletId, dropId, txHash);
  res.json(result);
});

// ─── Logs ─────────────────────────────────────────────────────
app.get("/logs", auth, (req, res) => {
  const { runId, limit } = req.query;
  let logs = store.logs;
  if (runId) logs = logs.filter(l => l.runId === runId);
  res.json(logs.slice(0, parseInt(limit) || 200));
});

// ─── Overview (dashboard summary) ────────────────────────────
app.get("/overview", auth, (req, res) => {
  const upcomingTasks = store.tasks
    .filter(t => t.status === "scheduled" && t.scheduledAt)
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 5);

  res.json({
    wallets: store.wallets.length,
    activeWallets: store.wallets.filter(w => w.active).length,
    drops: store.drops.length,
    tasks: store.tasks.length,
    scheduledTasks: store.tasks.filter(t => t.status === "scheduled").length,
    runs: store.runs.length,
    successfulRuns: store.runs.filter(r => r.status === "done").length,
    totalMints: store.pnl.length,
    recentRuns: store.runs.slice(0, 5),
    upcomingTasks,
    systemHealth: {
      server: "ok",
      mintWorker: "ok",
      uptime: Math.floor(process.uptime()),
    },
  });
});

// ─── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 MintBot Server running on port ${PORT}`);
  console.log(`🔑 API Secret: ${API_SECRET.slice(0,4)}****`);
  console.log(`📡 Health: http://localhost:${PORT}/health\n`);
  log(`MintBot server started on port ${PORT}`, "success");
});
