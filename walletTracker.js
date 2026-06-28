// walletTracker.js — Copy-mint: watch a wallet, fire when it mints
const { ethers } = require("ethers");
const { store, log } = require("./jobQueue");
const { mintWithRetry, CHAINS } = require("./mintEngine");

// Active trackers: { id, targetAddress, dropId, label, provider, status, detectedTx, firedAt }
const trackers = {};

function getProvider(chain, rpcKey) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`Unknown chain: ${chain}`);
  // Use WebSocket if available for faster detection, fallback to polling
  return new ethers.JsonRpcProvider(c.rpc(rpcKey || ""));
}

async function isMintTx(tx, contractAddress) {
  if (!tx || !tx.to) return false;
  // Match if tx is sent to the target contract
  if (contractAddress && tx.to.toLowerCase() !== contractAddress.toLowerCase()) return false;
  // Check for common mint function selectors in calldata
  const mintSelectors = [
    "0xa0712d68", // mint(uint256)
    "0x1249c58b", // mint()
    "0x40d097c3", // safeMint(address)
    "0x6a627842", // mint(address)
    "0x84bb1e42", // mint(address,uint256)
    "0xd85d3d27", // publicMint(uint256)
    "0x4ded8d52", // whitelistMint(uint256,bytes32[])
  ];
  if (tx.data && tx.data.length >= 10) {
    const selector = tx.data.slice(0, 10).toLowerCase();
    if (mintSelectors.includes(selector)) return true;
  }
  // If no contract filter and tx has value > 0 and data (likely a mint)
  if (!contractAddress && tx.value > 0n && tx.data && tx.data.length > 2) return true;
  return false;
}

async function startTracker(id, targetAddress, dropId, label, chain, contractAddress) {
  if (trackers[id]) await stopTracker(id);

  const drop = store.drops.find(d => d.id === dropId);
  if (!drop) throw new Error("Drop not found");

  const tracker = {
    id,
    targetAddress: targetAddress.toLowerCase(),
    dropId,
    label: label || `Tracker ${id.slice(0, 6)}`,
    chain: chain || drop.chain,
    contractAddress: contractAddress || drop.contractAddress || null,
    status: "watching",
    detectedTx: null,
    firedAt: null,
    startedAt: new Date().toISOString(),
    triggerCount: 0,
    pollInterval: null,
    lastBlock: null,
  };
  trackers[id] = tracker;

  log(`👁 Tracker [${tracker.label}] started — watching ${targetAddress.slice(0, 8)}… on ${tracker.chain}`, "info");

  // Poll every 2 seconds for new transactions
  tracker.pollInterval = setInterval(async () => {
    try {
      if (tracker.status !== "watching") return;
      const provider = getProvider(tracker.chain, store.rpcKey);
      const currentBlock = await provider.getBlockNumber();

      if (!tracker.lastBlock) {
        tracker.lastBlock = currentBlock;
        return;
      }

      if (currentBlock <= tracker.lastBlock) return;

      // Scan new blocks for target wallet activity
      for (let b = tracker.lastBlock + 1; b <= currentBlock; b++) {
        const block = await provider.getBlock(b, true);
        if (!block || !block.transactions) continue;

        for (const tx of block.transactions) {
          if (!tx || !tx.from) continue;
          if (tx.from.toLowerCase() !== tracker.targetAddress) continue;

          const isMint = await isMintTx(tx, tracker.contractAddress);
          if (!isMint) continue;

          // 🎯 Detected a mint from target wallet!
          tracker.detectedTx = tx.hash;
          tracker.triggerCount++;
          log(`🎯 [${tracker.label}] DETECTED mint tx from ${targetAddress.slice(0, 8)}… → ${tx.hash}`, "success");
          log(`⚡ [${tracker.label}] Auto-firing copy mint across ${store.wallets.filter(w => w.active).length} wallets…`, "info");

          // Fire immediately
          await fireCopyMint(tracker, tx);
        }
        tracker.lastBlock = b;
      }
    } catch (e) {
      // Silently retry on network errors
      if (!e.message?.includes("timeout")) {
        log(`[Tracker ${tracker.label}] Poll error: ${e.message}`, "warn");
      }
    }
  }, 2000);

  return tracker;
}

async function fireCopyMint(tracker, detectedTx) {
  const drop = store.drops.find(d => d.id === tracker.dropId);
  if (!drop) return;

  tracker.status = "firing";
  tracker.firedAt = new Date().toISOString();

  const activeWallets = store.wallets.filter(w => w.active);
  if (activeWallets.length === 0) {
    log(`[${tracker.label}] No active wallets to copy-mint with`, "error");
    tracker.status = "watching";
    return;
  }

  // Use detected tx's contract if no contract set on drop
  const cfg = {
    ...drop,
    contractAddress: tracker.contractAddress || detectedTx.to || drop.contractAddress,
    // Try to match the detected tx value as mint price
    mintPrice: detectedTx.value > 0n
      ? parseFloat(ethers.formatEther(detectedTx.value)).toFixed(6)
      : drop.mintPrice,
  };

  const runLog = (msg, type) => log(msg, type);

  try {
    if (drop.concurrentMint !== false) {
      const results = await Promise.allSettled(
        activeWallets.map(w => mintWithRetry(w, cfg, store.rpcKey, runLog,
          parseInt(drop.retryCount) || 3, parseInt(drop.retryDelayMs) || 2000))
      );
      const ok = results.filter(r => r.value?.success).length;
      log(`✅ [${tracker.label}] Copy-mint done — ${ok}/${activeWallets.length} succeeded`, ok > 0 ? "success" : "error");
    } else {
      for (const w of activeWallets) {
        await mintWithRetry(w, cfg, store.rpcKey, runLog, parseInt(drop.retryCount) || 3, parseInt(drop.retryDelayMs) || 2000);
      }
    }
  } catch (e) {
    log(`[${tracker.label}] Copy-mint error: ${e.message}`, "error");
  }

  tracker.status = "watching"; // back to watching for more
}

async function stopTracker(id) {
  const tracker = trackers[id];
  if (!tracker) return false;
  if (tracker.pollInterval) clearInterval(tracker.pollInterval);
  tracker.status = "stopped";
  log(`⏹ Tracker [${tracker.label}] stopped`, "warn");
  return true;
}

function getTrackers() {
  return Object.values(trackers).map(t => ({
    id: t.id,
    label: t.label,
    targetAddress: t.targetAddress,
    dropId: t.dropId,
    chain: t.chain,
    contractAddress: t.contractAddress,
    status: t.status,
    detectedTx: t.detectedTx,
    firedAt: t.firedAt,
    startedAt: t.startedAt,
    triggerCount: t.triggerCount,
  }));
}

function getTracker(id) {
  const t = trackers[id];
  if (!t) return null;
  return {
    id: t.id, label: t.label, targetAddress: t.targetAddress,
    dropId: t.dropId, chain: t.chain, contractAddress: t.contractAddress,
    status: t.status, detectedTx: t.detectedTx, firedAt: t.firedAt,
    startedAt: t.startedAt, triggerCount: t.triggerCount,
  };
}

module.exports = { startTracker, stopTracker, getTrackers, getTracker, trackers };
