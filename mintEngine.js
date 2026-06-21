// mintEngine.js — Core on-chain minting logic
const { ethers } = require("ethers");

const CHAINS = {
  eth:      { name: "Ethereum",  symbol: "ETH",  explorer: "https://etherscan.io/tx/",         rpc: (k) => `https://mainnet.infura.io/v3/${k}` },
  base:     { name: "Base",      symbol: "ETH",  explorer: "https://basescan.org/tx/",          rpc: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}` },
  polygon:  { name: "Polygon",   symbol: "MATIC", explorer: "https://polygonscan.com/tx/",      rpc: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}` },
  bsc:      { name: "BNB Chain", symbol: "BNB",  explorer: "https://bscscan.com/tx/",           rpc: () => "https://bsc-dataseed.binance.org" },
  arbitrum: { name: "Arbitrum",  symbol: "ETH",  explorer: "https://arbiscan.io/tx/",           rpc: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}` },
  zora:     { name: "Zora",      symbol: "ETH",  explorer: "https://explorer.zora.energy/tx/",  rpc: () => "https://rpc.zora.energy" },
};

function getProvider(chain, rpcKey) {
  const c = CHAINS[chain];
  if (!c) throw new Error(`Unknown chain: ${chain}`);
  return new ethers.JsonRpcProvider(c.rpc(rpcKey || ""));
}

function getSigner(privateKey, chain, rpcKey) {
  return new ethers.Wallet(privateKey, getProvider(chain, rpcKey));
}

async function buildTx(signer, cfg) {
  const provider = signer.provider;
  const feeData = await provider.getFeeData();

  let maxFeePerGas, maxPriorityFeePerGas;
  const capGwei = ethers.parseUnits(String(cfg.maxGasGwei || "100"), "gwei");

  if (cfg.gasStrategy === "fixed") {
    maxFeePerGas = capGwei;
    maxPriorityFeePerGas = ethers.parseUnits(String(cfg.priorityFeeGwei || "2"), "gwei");
  } else if (cfg.gasStrategy === "aggressive") {
    maxFeePerGas = (feeData.maxFeePerGas || capGwei) * 120n / 100n;
    maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas || ethers.parseUnits("2", "gwei")) * 120n / 100n;
  } else {
    maxFeePerGas = feeData.maxFeePerGas || capGwei;
    maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || ethers.parseUnits(String(cfg.priorityFeeGwei || "2"), "gwei");
  }

  if (maxFeePerGas > capGwei) {
    throw new Error(`GAS_CAP: current ${ethers.formatUnits(maxFeePerGas, "gwei")} Gwei > cap ${cfg.maxGasGwei} Gwei`);
  }

  // Build calldata
  let data;
  if (cfg.customABI && cfg.customABI.trim()) {
    const iface = new ethers.Interface(JSON.parse(cfg.customABI));
    const fnName = cfg.mintFunctionSig.split("(")[0];
    data = iface.encodeFunctionData(fnName, [parseInt(cfg.mintCopies || "1")]);
  } else {
    const sig = cfg.mintFunctionSig || "mint(uint256)";
    const iface = new ethers.Interface([`function ${sig}`]);
    const fnName = sig.split("(")[0];
    const hasParams = sig.includes("uint256");
    data = iface.encodeFunctionData(fnName, hasParams ? [parseInt(cfg.mintCopies || "1")] : []);
  }

  return {
    to: cfg.contractAddress,
    data,
    value: ethers.parseEther(String(cfg.mintPrice || "0")),
    gasLimit: BigInt(cfg.gasLimit || "250000"),
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}

async function mintOnce(wallet, cfg, rpcKey, logFn) {
  const signer = getSigner(wallet.privateKey, cfg.chain, rpcKey);
  const label = wallet.label || wallet.address?.slice(0, 8);

  try {
    logFn(`📤 [${label}] Building tx…`, "info");
    const tx = await buildTx(signer, cfg);
    logFn(`📤 [${label}] Sending to ${cfg.contractAddress.slice(0,8)}…`, "info");
    const sent = await signer.sendTransaction(tx);
    logFn(`✅ [${label}] TX sent: ${sent.hash}`, "success");

    const receipt = await sent.wait(1);
    logFn(`🎉 [${label}] Confirmed block ${receipt.blockNumber} | gas: ${receipt.gasUsed}`, "success");

    return { success: true, hash: sent.hash, gasUsed: receipt.gasUsed.toString(), blockNumber: receipt.blockNumber };
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    logFn(`❌ [${label}] ${msg}`, "error");
    return { success: false, error: msg };
  }
}

async function mintWithRetry(wallet, cfg, rpcKey, logFn, retries = 3, delayMs = 2000) {
  for (let i = 1; i <= retries; i++) {
    if (i > 1) {
      logFn(`🔄 [${wallet.label}] Retry ${i}/${retries}…`, "warn");
      await new Promise(r => setTimeout(r, delayMs));
    }
    const result = await mintOnce(wallet, cfg, rpcKey, logFn);
    if (result.success) return result;
    if (result.error?.startsWith("GAS_CAP")) return result;
    if (!cfg.retryOnFail) return result;
  }
  return { success: false, error: "Max retries reached" };
}

async function rbfBump(wallet, cfg, rpcKey, origHash, bumpPct = 15, logFn) {
  try {
    const signer = getSigner(wallet.privateKey, cfg.chain, rpcKey);
    const provider = signer.provider;
    const origTx = await provider.getTransaction(origHash);
    if (!origTx) throw new Error("Original tx not found");

    const bump = BigInt(bumpPct);
    const newMaxFee = origTx.maxFeePerGas * (100n + bump) / 100n;
    const newPrio = origTx.maxPriorityFeePerGas * (100n + bump) / 100n;

    logFn(`⚡ [RBF] Bumping ${wallet.label} by ${bumpPct}%`, "warn");
    const rbfTx = await signer.sendTransaction({
      to: origTx.to, data: origTx.data, value: origTx.value,
      nonce: origTx.nonce, gasLimit: origTx.gasLimit,
      maxFeePerGas: newMaxFee, maxPriorityFeePerGas: newPrio,
    });
    logFn(`⚡ [RBF] Replacement TX: ${rbfTx.hash}`, "tx");
    return { success: true, hash: rbfTx.hash };
  } catch (e) {
    logFn(`[RBF] Failed: ${e.message}`, "error");
    return { success: false, error: e.message };
  }
}

async function getGas(chain, rpcKey) {
  const provider = getProvider(chain, rpcKey);
  const fee = await provider.getFeeData();
  return {
    maxFeePerGas: parseFloat(ethers.formatUnits(fee.maxFeePerGas || 0n, "gwei")).toFixed(2),
    maxPriorityFeePerGas: parseFloat(ethers.formatUnits(fee.maxPriorityFeePerGas || 0n, "gwei")).toFixed(2),
    gasPrice: parseFloat(ethers.formatUnits(fee.gasPrice || 0n, "gwei")).toFixed(2),
  };
}

async function getBalance(privateKey, chain, rpcKey) {
  const provider = getProvider(chain, rpcKey);
  const wallet = new ethers.Wallet(privateKey);
  const bal = await provider.getBalance(wallet.address);
  return { address: wallet.address, balance: parseFloat(ethers.formatEther(bal)).toFixed(6), symbol: CHAINS[chain]?.symbol };
}

function deriveAddress(privateKey) {
  return new ethers.Wallet(privateKey).address;
}

module.exports = { mintOnce, mintWithRetry, rbfBump, getGas, getBalance, deriveAddress, CHAINS };
