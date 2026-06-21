// jobQueue.js — In-memory job queue, drop manager, scheduler
const { v4: uuidv4 } = require("uuid");
const schedule = require("node-schedule");
const { mintWithRetry, rbfBump, getGas } = require("./mintEngine");

// ─── In-memory store (persists as long as server is up) ───────
const store = {
  wallets: [],     // { id, label, privateKey, address, active }
  drops: [],       // { id, name, chain, contractAddress, mintFunctionSig, mintPrice, mintCopies, gasLimit, maxGasGwei, priorityFeeGwei, gasStrategy, retryOnFail, retryCount, retryDelayMs, rbfEnabled, rbfBumpPct, concurrentMint, whitelist, createdAt }
  tasks: [],       // { id, dropId, name, scheduledAt, status, runId, createdAt }
  runs: [],        // { id, taskId, dropId, status, startedAt, finishedAt, results, logs }
  pnl: [],         // { runId, hash, wallet, chain, mintPrice, gasCost, profit }
  logs: [],        // { time, msg, type, runId? }
  rpcKey: "",
  scheduledJobs: {}, // taskId -> node-schedule job
};

// ─── Logging ──────────────────────────────────────────────────
function log(msg, type = "info", runId = null) {
  const entry = { time: new Date().toISOString(), msg, type, runId };
  store.logs.unshift(entry);
  if (store.logs.length > 1000) store.logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
  return entry;
}

// ─── Wallets ──────────────────────────────────────────────────
function addWallet(label, privateKey, address) {
  const id = uuidv4();
  store.wallets.push({ id, label, privateKey, address, active: true, addedAt: new Date().toISOString() });
  log(`Wallet added: ${label} (${address.slice(0,8)}…)`, "info");
  return id;
}

function getWallets() {
  return store.wallets.map(w => ({ ...w, privateKey: "***HIDDEN***" }));
}

function setWalletActive(id, active) {
  const w = store.wallets.find(w => w.id === id);
  if (w) w.active = active;
}

function removeWallet(id) {
  store.wallets = store.wallets.filter(w => w.id !== id);
}

// ─── Drops ────────────────────────────────────────────────────
function createDrop(data) {
  const drop = {
    id: uuidv4(),
    name: data.name || "Unnamed Drop",
    chain: data.chain || "eth",
    contractAddress: data.contractAddress || "",
    mintFunctionSig: data.mintFunctionSig || "mint(uint256)",
    mintPrice: data.mintPrice || "0",
    mintCopies: data.mintCopies || "1",
    gasLimit: data.gasLimit || "250000",
    maxGasGwei: data.maxGasGwei || "100",
    priorityFeeGwei: data.priorityFeeGwei || "2",
    gasStrategy: data.gasStrategy || "auto",
    retryOnFail: data.retryOnFail !== false,
    retryCount: data.retryCount || 3,
    retryDelayMs: data.retryDelayMs || 2000,
    rbfEnabled: data.rbfEnabled !== false,
    rbfBumpPct: data.rbfBumpPct || 15,
    concurrentMint: data.concurrentMint !== false,
    whitelist: data.whitelist || [],
    customABI: data.customABI || "",
    createdAt: new Date().toISOString(),
  };
  store.drops.push(drop);
  log(`Drop created: ${drop.name}`, "info");
  return drop;
}

function updateDrop(id, data) {
  const idx = store.drops.findIndex(d => d.id === id);
  if (idx === -1) return null;
  store.drops[idx] = { ...store.drops[idx], ...data };
  return store.drops[idx];
}

function deleteDrop(id) {
  store.drops = store.drops.filter(d => d.id !== id);
  store.tasks = store.tasks.filter(t => t.dropId !== id);
}

// ─── Tasks ────────────────────────────────────────────────────
function createTask(dropId, name, scheduledAt) {
  const task = {
    id: uuidv4(),
    dropId,
    name: name || "Mint Task",
    scheduledAt: scheduledAt || null, // ISO string or null = immediate
    status: "pending", // pending | scheduled | running | done | failed | cancelled
    runId: null,
    createdAt: new Date().toISOString(),
  };
  store.tasks.push(task);
  log(`Task created: ${task.name} for drop ${dropId}`, "info");

  if (scheduledAt) {
    scheduleTask(task);
  }
  return task;
}

function scheduleTask(task) {
  const fireAt = new Date(task.scheduledAt);
  if (fireAt <= new Date()) {
    log(`Task ${task.id} scheduled time is in the past — firing now`, "warn");
    executeTask(task.id);
    return;
  }

  task.status = "scheduled";
  const job = schedule.scheduleJob(fireAt, () => {
    log(`🕐 Scheduled task fired: ${task.name}`, "success");
    executeTask(task.id);
  });
  store.scheduledJobs[task.id] = job;
  log(`⏰ Task "${task.name}" scheduled for ${fireAt.toLocaleString()}`, "info");
}

function cancelTask(taskId) {
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return false;
  if (store.scheduledJobs[taskId]) {
    store.scheduledJobs[taskId].cancel();
    delete store.scheduledJobs[taskId];
  }
  task.status = "cancelled";
  log(`Task cancelled: ${task.name}`, "warn");
  return true;
}

// ─── Execution ────────────────────────────────────────────────
async function executeTask(taskId) {
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) return { error: "Task not found" };

  const drop = store.drops.find(d => d.id === task.dropId);
  if (!drop) return { error: "Drop not found" };

  const activeWallets = store.wallets.filter(w => w.active);
  if (activeWallets.length === 0) {
    task.status = "failed";
    log("No active wallets for task execution", "error");
    return { error: "No active wallets" };
  }

  const runId = uuidv4();
  const run = {
    id: runId,
    taskId,
    dropId: drop.id,
    dropName: drop.name,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
    logs: [],
  };
  store.runs.unshift(run);
  task.status = "running";
  task.runId = runId;

  const runLog = (msg, type) => {
    const entry = log(msg, type, runId);
    run.logs.push(entry);
  };

  runLog(`🚀 Run started | Drop: ${drop.name} | Chain: ${drop.chain} | Wallets: ${activeWallets.length}`, "success");
  runLog(`ℹ Contract: ${drop.contractAddress} | fn: ${drop.mintFunctionSig} | price: ${drop.mintPrice}`, "info");

  // Whitelist filter
  let wallets = activeWallets;
  if (drop.whitelist && drop.whitelist.length > 0) {
    wallets = activeWallets.filter(w => drop.whitelist.map(a => a.toLowerCase()).includes(w.address.toLowerCase()));
    runLog(`📋 Whitelist filter: ${wallets.length}/${activeWallets.length} wallets eligible`, "info");
    if (wallets.length === 0) {
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      task.status = "failed";
      runLog("❌ No whitelisted wallets active", "error");
      return { error: "No whitelisted wallets" };
    }
  }

  const cfg = { ...drop };
  const rpcKey = store.rpcKey;

  let results;
  if (drop.concurrentMint) {
    runLog(`⚡ Firing ${wallets.length} wallets concurrently…`, "info");
    const settled = await Promise.allSettled(
      wallets.map(w => mintWithRetry(w, cfg, rpcKey, runLog, parseInt(drop.retryCount) || 3, parseInt(drop.retryDelayMs) || 2000))
    );
    results = settled.map((r, i) => ({
      wallet: wallets[i].label,
      address: wallets[i].address,
      ...(r.status === "fulfilled" ? r.value : { success: false, error: r.reason?.message }),
    }));
  } else {
    results = [];
    for (const w of wallets) {
      if (task.status === "cancelled") break;
      const r = await mintWithRetry(w, cfg, rpcKey, runLog, parseInt(drop.retryCount) || 3, parseInt(drop.retryDelayMs) || 2000);
      results.push({ wallet: w.label, address: w.address, ...r });
    }
  }

  run.results = results;
  run.finishedAt = new Date().toISOString();
  const ok = results.filter(r => r.success).length;
  run.status = ok > 0 ? "done" : "failed";
  task.status = run.status;

  runLog(`✅ Run complete — ${ok}/${wallets.length} mints succeeded`, ok > 0 ? "success" : "error");

  // PnL tracking
  results.filter(r => r.success).forEach(r => {
    store.pnl.push({
      runId,
      hash: r.hash,
      wallet: r.wallet,
      chain: drop.chain,
      dropName: drop.name,
      mintPrice: parseFloat(drop.mintPrice || "0"),
      gasCost: parseFloat(r.gasUsed || "0") * 0.000000001,
      time: new Date().toISOString(),
    });
  });

  return run;
}

async function fireNow(taskId) {
  return executeTask(taskId);
}

// ─── RBF ──────────────────────────────────────────────────────
async function triggerRBF(walletId, dropId, txHash) {
  const wallet = store.wallets.find(w => w.id === walletId);
  const drop = store.drops.find(d => d.id === dropId);
  if (!wallet || !drop) return { error: "Wallet or drop not found" };
  return rbfBump(wallet, drop, store.rpcKey, txHash, drop.rbfBumpPct || 15, (m, t) => log(m, t));
}

// ─── Gas poller ───────────────────────────────────────────────
let gasCache = {};
async function pollGas(chain) {
  try {
    const data = await getGas(chain || "eth", store.rpcKey);
    gasCache[chain || "eth"] = { ...data, updatedAt: new Date().toISOString() };
    return gasCache[chain || "eth"];
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = {
  store, log,
  addWallet, getWallets, setWalletActive, removeWallet,
  createDrop, updateDrop, deleteDrop,
  createTask, cancelTask, fireNow, executeTask,
  triggerRBF,
  pollGas, gasCache,
};
