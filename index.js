require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');
const { ethers }  = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const CryptoJS    = require('crypto-js');
const axios       = require('axios');

// ── Config ────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const ENC_SECRET = process.env.ENCRYPTION_SECRET || 'ghostmint_change_me_32chars_min!!';
const DASH_PASS  = process.env.DASHBOARD_PASSWORD || 'ghostmint123';
const DATA_FILE  = path.join(__dirname, 'data.json');

const CHAINS = {
  ethereum: { name:'Ethereum', rpc: process.env.ETH_RPC     || 'https://ethereum.publicnode.com', sym:'ETH',  ex:'https://etherscan.io/tx/' },
  base:     { name:'Base',     rpc: process.env.BASE_RPC    || 'https://mainnet.base.org',         sym:'ETH',  ex:'https://basescan.org/tx/' },
  arbitrum: { name:'Arbitrum', rpc: process.env.ARB_RPC     || 'https://arb1.arbitrum.io/rpc',    sym:'ETH',  ex:'https://arbiscan.io/tx/' },
  polygon:  { name:'Polygon',  rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',          sym:'MATIC',ex:'https://polygonscan.com/tx/' },
};

// ── Data ──────────────────────────────────────────────────
function loadDB() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    return { wallets:[], tasks:[], activity:[], pnl:[], snipers:[], ...d };
  }
  catch { return { wallets:[], tasks:[], activity:[], pnl:[], snipers:[] }; }
}
function saveDB() { fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); }
let DB = loadDB();

// ── Crypto ────────────────────────────────────────────────
const encryptPK = pk  => CryptoJS.AES.encrypt(pk, ENC_SECRET).toString();
const decryptPK = enc => CryptoJS.AES.decrypt(enc, ENC_SECRET).toString(CryptoJS.enc.Utf8);

// ── Logger ────────────────────────────────────────────────
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── Activity ──────────────────────────────────────────────
function logActivity(status, title, walletLabel, txHash, chain) {
  DB.activity.unshift({ status, title, walletLabel, txHash, explorer: chain?.ex, time: Date.now() });
  if (DB.activity.length > 200) DB.activity.pop();
  saveDB();
}

// ── Helpers ───────────────────────────────────────────────
function fmtCD(ms) {
  const s=Math.floor(ms/1000), m=Math.floor(s/60), h=Math.floor(m/60), d=Math.floor(h/24);
  return d>0?`${d}d ${h%24}h`:h>0?`${h}h ${m%60}m`:m>0?`${m}m ${s%60}s`:`${s}s`;
}

// ── Mint executor ─────────────────────────────────────────
async function executeMint({ wallet, contractAddr, fnName='mint', qty=1, priceETH=0, gasGwei=null, chain }) {
  const chainCfg = CHAINS[chain] || CHAINS.ethereum;
  const pk       = decryptPK(wallet.encryptedKey);
  const provider = new ethers.JsonRpcProvider(chainCfg.rpc);
  const signer   = new ethers.Wallet(pk, provider);
  const abi = [{inputs:[{name:'quantity',type:'uint256'}],name:fnName,outputs:[],stateMutability:'payable',type:'function'}];
  const contract  = new ethers.Contract(contractAddr, abi, signer);
  const value     = ethers.parseEther((priceETH * qty).toString());
  const overrides = { value };
  if (gasGwei) overrides.gasPrice = ethers.parseUnits(gasGwei.toString(), 'gwei');
  const tx = await contract[fnName](qty, overrides);
  log(`Tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  log(`Confirmed: ${tx.hash} (block ${receipt.blockNumber})`);
  return tx.hash;
}

// ── Wallet Sniper / Copy-Mint Engine ─────────────────────────
// Watches a target wallet block-by-block and, when it sees the
// target call a contract (typically a mint), replicates that exact
// call — same contract, same calldata — from one of your own
// wallets. Detection happens once the target's tx is confirmed in
// a block, so this is a best-effort copier riding public RPCs, not
// a mempool front-runner.
const sniperProviders = {};  // chain -> ethers provider, only live while a sniper is active on it
const sniperSeenTx     = {}; // sniperId -> Set of already-handled tx hashes (capped)

function markSeen(sniperId, hash) {
  if (!sniperSeenTx[sniperId]) sniperSeenTx[sniperId] = new Set();
  const set = sniperSeenTx[sniperId];
  set.add(hash);
  if (set.size > 500) set.delete(set.values().next().value);
}
const alreadySeen = (sniperId, hash) => sniperSeenTx[sniperId]?.has(hash);

const activeSnipersForChain = chain => DB.snipers.filter(s => s.active && s.chain === chain);

function ensureChainWatcher(chain) {
  if (sniperProviders[chain] || !CHAINS[chain]) return;
  const provider = new ethers.JsonRpcProvider(CHAINS[chain].rpc);
  provider.pollingInterval = 2500;
  sniperProviders[chain] = provider;
  provider.on('block', bn => onBlock(chain, bn).catch(e => log(`Sniper block err (${chain}): ${e.message}`)));
  log(`🎯 Sniper watcher started on ${CHAINS[chain].name}`);
}

function teardownChainWatcherIfIdle(chain) {
  if (activeSnipersForChain(chain).length) return;
  const provider = sniperProviders[chain];
  if (!provider) return;
  provider.removeAllListeners();
  provider.destroy?.();
  delete sniperProviders[chain];
  log(`🎯 Sniper watcher stopped on ${chain} (no active targets)`);
}

async function onBlock(chain, blockNumber) {
  const snipers = activeSnipersForChain(chain);
  if (!snipers.length) return;
  const provider = sniperProviders[chain];
  const block = await provider.getBlock(blockNumber, true);
  if (!block?.prefetchedTransactions) return;
  for (const tx of block.prefetchedTransactions) {
    if (!tx.to || !tx.data || tx.data === '0x') continue; // skip plain transfers / contract creations
    for (const sniper of snipers) {
      if (tx.from.toLowerCase() !== sniper.targetAddress.toLowerCase()) continue;
      if (alreadySeen(sniper.id, tx.hash)) continue;
      markSeen(sniper.id, tx.hash);
      fireSnipe(sniper, tx, chain).catch(e => log(`Snipe fire error: ${e.message}`));
    }
  }
}

async function fireSnipe(sniper, targetTx, chain) {
  const chainCfg = CHAINS[chain];
  const wallet   = DB.wallets.find(w => w.label === sniper.walletLabel);
  if (!wallet) { tg(`❌ *Sniper "${sniper.label}" failed*\nFiring wallet "${sniper.walletLabel}" not found.`); return; }

  let value = targetTx.value ?? 0n;
  if (sniper.valueMode === 'fixed') value = ethers.parseEther(String(sniper.fixedValueETH || 0));
  if (sniper.maxValueETH != null) {
    const cap = ethers.parseEther(String(sniper.maxValueETH));
    if (value > cap) {
      logActivity('fail', `Sniper skipped (value ${ethers.formatEther(value)} ETH > cap)`, wallet.label, null, chainCfg);
      tg(`⚠️ *Sniper "${sniper.label}" skipped*\nTarget tx wants ${ethers.formatEther(value)} ETH, over your ${sniper.maxValueETH} ETH cap.`);
      return;
    }
  }

  tg(`🎯 *Target minting detected!*\nSniper: *${sniper.label}*\nTarget: \`${sniper.targetAddress.slice(0,8)}...\`\nCopying with wallet *${wallet.label}*...`);

  try {
    const pk       = decryptPK(wallet.encryptedKey);
    const provider = sniperProviders[chain] || new ethers.JsonRpcProvider(chainCfg.rpc);
    const signer   = new ethers.Wallet(pk, provider);
    const overrides = { to: targetTx.to, data: targetTx.data, value };

    const boostBp = BigInt(100 + (sniper.gasBoostPercent ?? 20)); // e.g. 120 = +20%
    if (targetTx.maxFeePerGas) {
      overrides.maxFeePerGas         = (targetTx.maxFeePerGas * boostBp) / 100n;
      overrides.maxPriorityFeePerGas = ((targetTx.maxPriorityFeePerGas || targetTx.maxFeePerGas) * boostBp) / 100n;
    } else if (targetTx.gasPrice) {
      overrides.gasPrice = (targetTx.gasPrice * boostBp) / 100n;
    }

    const tx = await signer.sendTransaction(overrides);
    log(`Sniper tx sent: ${tx.hash}`);
    await tx.wait();
    wallet.minted = (wallet.minted || 0) + 1;
    sniper.hits = (sniper.hits || 0) + 1;
    sniper.lastFiredAt = Date.now();
    saveDB();
    logActivity('success', `Sniper copy-mint (${sniper.label})`, wallet.label, tx.hash, chainCfg);
    tg(`✅ *Snipe successful!*\nSniper: *${sniper.label}*\nWallet: *${wallet.label}*\n[View tx](${chainCfg.ex}${tx.hash})`);
  } catch (e) {
    sniper.fails = (sniper.fails || 0) + 1; saveDB();
    logActivity('fail', `Sniper copy-mint failed (${sniper.label})`, wallet.label, null, chainCfg);
    tg(`❌ *Snipe failed*\nSniper: *${sniper.label}*\nError: ${(e.reason || e.message || 'Unknown').slice(0,150)}`);
  }
}

// ── Telegram ──────────────────────────────────────────────
let bot = null;
function tg(msg) {
  if (bot && CHAT_ID) bot.sendMessage(CHAT_ID, msg, { parse_mode:'Markdown' }).catch(e => log('TG: '+e.message));
}

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  log('Telegram bot started');

  bot.onText(/\/start|\/help/, () => {
    tg(`👻 *GhostMint Bot*\n\n*Commands:*\n/wallets — list wallets\n/tasks — scheduled tasks\n/snipers — copy-mint watchers\n/activity — recent mints\n/gas — live gas prices\n/stats — overview\n/canceltask <id> — cancel task\n/removewallet <label> — remove wallet\n/mintnow <label> <contract> <qty> <price> <chain> — instant mint`);
  });

  bot.onText(/\/snipers/, () => {
    if (!DB.snipers.length) return tg('No snipers configured. Add one via the web dashboard → Sniper tab.');
    const list = DB.snipers.map(s =>
      `${s.active?'🟢':'⚪'} *${s.label}*\nTarget: \`${s.targetAddress.slice(0,10)}...\`\nChain: ${CHAINS[s.chain]?.name||s.chain} · Wallet: ${s.walletLabel}\nHits: ${s.hits||0} · Fails: ${s.fails||0}`
    ).join('\n\n');
    tg(`🎯 *Snipers (${DB.snipers.length})*\n\n${list}`);
  });

  bot.onText(/\/wallets/, () => {
    if (!DB.wallets.length) return tg('No wallets yet. Add via the web dashboard.');
    const list = DB.wallets.map((w,i) =>
      `${i+1}. *${w.label}*\n   \`${w.address.slice(0,6)}...${w.address.slice(-4)}\` · ${CHAINS[w.chain]?.name||w.chain} · minted: ${w.minted||0}`
    ).join('\n\n');
    tg(`⬡ *Wallets (${DB.wallets.length})*\n\n${list}`);
  });

  bot.onText(/\/tasks/, () => {
    const pending = DB.tasks.filter(t => t.status === 'waiting');
    if (!pending.length) return tg('No scheduled tasks.');
    const list = pending.map(t => {
      const ms = t.mintTime - Date.now();
      return `⏱ *${t.name}*\nWallet: ${t.walletLabel}\nQty: ${t.qty} | Price: ${t.price>0?t.price+' ETH':'Free'}\nFires in: *${ms>0?fmtCD(ms):'NOW'}*\nID: \`${t.id}\``;
    }).join('\n\n');
    tg(`⏱ *Tasks (${pending.length})*\n\n${list}`);
  });

  bot.onText(/\/activity/, () => {
    const recent = DB.activity.slice(0, 10);
    if (!recent.length) return tg('No activity yet.');
    const list = recent.map(a => {
      const ico = a.status==='success'?'✅':'❌';
      const tx  = a.txHash?`\n   [View tx](${a.explorer}${a.txHash})`:'';
      return `${ico} ${a.title} · *${a.walletLabel}*\n   ${new Date(a.time).toLocaleString()}${tx}`;
    }).join('\n\n');
    tg(`📋 *Recent Activity*\n\n${list}`);
  });

  bot.onText(/\/gas/, async () => {
    try {
      const r = await axios.get('https://api.etherscan.io/api?module=gastracker&action=gasoracle');
      const d = r.data.result;
      tg(`⛽ *Live Gas (Ethereum)*\n🐢 Slow: *${d.SafeGasPrice}* Gwei\n⚡ Standard: *${d.ProposeGasPrice}* Gwei\n🚀 Fast: *${d.FastGasPrice}* Gwei\nBase fee: ${parseFloat(d.suggestBaseFee).toFixed(2)} Gwei`);
    } catch { tg('Could not fetch gas prices.'); }
  });

  bot.onText(/\/stats/, () => {
    const total   = DB.activity.length;
    const success = DB.activity.filter(a => a.status==='success').length;
    const minted  = DB.wallets.reduce((s,w) => s+(w.minted||0), 0);
    const pending = DB.tasks.filter(t => t.status==='waiting').length;
    tg(`📊 *GhostMint Stats*\n\n⬡ Wallets: *${DB.wallets.length}*\n⏱ Pending: *${pending}*\n⚡ Minted: *${minted}*\n✅ Success rate: *${total?Math.round(success/total*100):0}%*\n⏰ Uptime: ${fmtCD(process.uptime()*1000)}`);
  });

  bot.onText(/\/canceltask (.+)/, (msg, match) => {
    const id  = parseInt(match[1]);
    const idx = DB.tasks.findIndex(t => t.id===id);
    if (idx===-1) return tg('Task not found. Use /tasks to see IDs.');
    const name = DB.tasks[idx].name;
    DB.tasks.splice(idx, 1); saveDB();
    if (taskTimers[id]) { clearTimeout(taskTimers[id]); delete taskTimers[id]; }
    tg(`✅ Task *${name}* cancelled.`);
  });

  bot.onText(/\/removewallet (.+)/, (msg, match) => {
    const label = match[1].trim();
    const idx   = DB.wallets.findIndex(w => w.label.toLowerCase()===label.toLowerCase());
    if (idx===-1) return tg(`Wallet "${label}" not found.`);
    DB.wallets.splice(idx, 1); saveDB();
    tg(`✅ Wallet *${label}* removed.`);
  });

  bot.onText(/\/mintnow (.+)/, async (msg, match) => {
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) return tg('Usage: /mintnow <label> <contract> [qty] [price] [chain]');
    const [label, contract, qtyStr, priceStr, chain] = parts;
    const wallet = DB.wallets.find(w => w.label.toLowerCase()===label.toLowerCase());
    if (!wallet) return tg(`Wallet "${label}" not found. Use /wallets.`);
    const qty=parseInt(qtyStr)||1, price=parseFloat(priceStr)||0, ch=chain||wallet.chain||'ethereum';
    tg(`⚡ Minting from *${wallet.label}*...\nContract: \`${contract.slice(0,10)}...\`\nQty: ${qty} | Price: ${price>0?price+' ETH':'Free'}`);
    try {
      const txHash = await executeMint({ wallet, contractAddr:contract, fnName:'mint', qty, priceETH:price, chain:ch });
      wallet.minted=(wallet.minted||0)+qty;
      logActivity('success',`Minted ${qty} NFT${qty>1?'s':''}`,wallet.label,txHash,CHAINS[ch]);
      tg(`✅ *Mint successful!*\nWallet: *${wallet.label}*\nQty: ${qty}\n[View tx](${CHAINS[ch].ex}${txHash})`);
    } catch(e) {
      logActivity('fail','Mint failed',wallet.label,null,CHAINS[ch]);
      tg(`❌ *Mint failed*\n${(e.reason||e.message||'Unknown error').slice(0,120)}`);
    }
  });

  setTimeout(() => tg(`👻 *GhostMint is online!*\n\nBot is running 24/7 on Railway.\nType /help for commands.`), 3000);
} else {
  log('⚠️  No TELEGRAM_BOT_TOKEN — Telegram disabled.');
}

// ── Task Scheduler ────────────────────────────────────────
const taskTimers = {};

function scheduleTask(task) {
  if (taskTimers[task.id]) clearTimeout(taskTimers[task.id]);
  const ms = task.mintTime - Date.now();
  if (ms <= 0) return;
  log(`Task "${task.name}" fires in ${fmtCD(ms)}`);
  taskTimers[task.id] = setTimeout(() => fireTask(task), ms);
}

async function fireTask(task) {
  log(`Firing: ${task.name}`);
  const wallet = DB.wallets.find(w => w.label===task.walletLabel);
  if (!wallet) {
    task.status='failed'; saveDB();
    tg(`❌ *Task failed: ${task.name}*\nWallet "${task.walletLabel}" not found.`);
    return;
  }
  task.status='running'; saveDB();
  tg(`⚡ *Auto-minting!*\nTask: *${task.name}*\nWallet: *${wallet.label}*\nQty: ${task.qty}`);
  try {
    const txHash = await executeMint({ wallet, contractAddr:task.contract, fnName:task.fn||'mint', qty:task.qty, priceETH:task.price||0, gasGwei:task.gas||null, chain:wallet.chain });
    task.status='done'; wallet.minted=(wallet.minted||0)+task.qty; saveDB();
    logActivity('success',`Auto-minted ${task.qty} NFT${task.qty>1?'s':''}`,wallet.label,txHash,CHAINS[wallet.chain]);
    tg(`✅ *Auto-mint SUCCESS!*\nTask: *${task.name}*\nWallet: *${wallet.label}*\nQty: ${task.qty}\n[View tx](${CHAINS[wallet.chain].ex}${txHash})`);
  } catch(e) {
    task.status='failed'; saveDB();
    logActivity('fail',`Auto-mint failed: ${task.name}`,wallet.label,null,CHAINS[wallet.chain]);
    tg(`❌ *Auto-mint FAILED*\nTask: *${task.name}*\nError: ${(e.reason||e.message||'Unknown').slice(0,120)}`);
    log(`Task failed: ${e.message}`);
  }
}

// Restore tasks on boot
DB.tasks.filter(t => t.status==='waiting' && t.mintTime>Date.now()).forEach(scheduleTask);
log(`Restored ${DB.tasks.filter(t=>t.status==='waiting').length} pending tasks`);

// Restore active snipers on boot
DB.snipers.filter(s => s.active).forEach(s => ensureChainWatcher(s.chain));
log(`🎯 Restored ${DB.snipers.filter(s=>s.active).length} active snipers`);

// ── Express ───────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

function auth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (token === DASH_PASS) return next();
  res.status(401).json({ error:'Unauthorized' });
}

// ── API ───────────────────────────────────────────────────
app.post('/api/login', (req,res) => {
  if (req.body.password===DASH_PASS) return res.json({ token:DASH_PASS, ok:true });
  res.status(401).json({ error:'Wrong password' });
});

app.get('/api/stats', auth, (req,res) => {
  const total=DB.activity.length, success=DB.activity.filter(a=>a.status==='success').length;
  res.json({ wallets:DB.wallets.length, tasks:DB.tasks.filter(t=>t.status==='waiting').length, minted:DB.wallets.reduce((s,w)=>s+(w.minted||0),0), rate:total?Math.round(success/total*100):0, uptime:Math.floor(process.uptime()) });
});

app.get('/api/wallets', auth, (req,res) => {
  res.json(DB.wallets.map(w=>({ label:w.label, address:w.address, chain:w.chain, minted:w.minted||0 })));
});

app.post('/api/wallets', auth, async (req,res) => {
  const { privateKey, label, chain } = req.body;
  if (!privateKey||!label) return res.status(400).json({ error:'privateKey and label required' });
  try {
    const w = new ethers.Wallet(privateKey);
    DB.wallets.push({ label, address:w.address, chain:chain||'ethereum', encryptedKey:encryptPK(privateKey), minted:0, addedAt:Date.now() });
    saveDB();
    tg(`⬡ *Wallet added*\nLabel: *${label}*\nAddress: \`${w.address.slice(0,6)}...${w.address.slice(-4)}\``);
    res.json({ ok:true, address:w.address });
  } catch { res.status(400).json({ error:'Invalid private key' }); }
});

app.delete('/api/wallets/:label', auth, (req,res) => {
  const idx = DB.wallets.findIndex(w=>w.label===req.params.label);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  DB.wallets.splice(idx,1); saveDB(); res.json({ ok:true });
});

app.get('/api/balance/:label', auth, async (req,res) => {
  const wallet = DB.wallets.find(w=>w.label===req.params.label);
  if (!wallet) return res.status(404).json({ error:'Not found' });
  try {
    const chain=CHAINS[wallet.chain], p=new ethers.JsonRpcProvider(chain.rpc);
    const bal=await p.getBalance(wallet.address);
    res.json({ balance:ethers.formatEther(bal), symbol:chain.sym });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/tasks', auth, (req,res) => res.json(DB.tasks));

app.post('/api/tasks', auth, (req,res) => {
  const { name, walletLabel, contract, fn, qty, price, gas, mintTime } = req.body;
  if (!name||!walletLabel||!contract||!mintTime) return res.status(400).json({ error:'Missing fields' });
  const wallet = DB.wallets.find(w=>w.label===walletLabel);
  if (!wallet) return res.status(404).json({ error:'Wallet not found' });
  const mt = new Date(mintTime).getTime();
  if (mt<=Date.now()) return res.status(400).json({ error:'Mint time must be in the future' });
  const task = { id:Date.now(), name, walletLabel, contract, fn:fn||'mint', qty:qty||1, price:price||0, gas:gas||null, mintTime:mt, status:'waiting', createdAt:Date.now() };
  DB.tasks.push(task); saveDB(); scheduleTask(task);
  tg(`⏱ *Task scheduled!*\nName: *${name}*\nWallet: *${walletLabel}*\nFires: ${new Date(mt).toLocaleString()}`);
  res.json({ ok:true, task });
});

app.delete('/api/tasks/:id', auth, (req,res) => {
  const id=parseInt(req.params.id), idx=DB.tasks.findIndex(t=>t.id===id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  DB.tasks.splice(idx,1); saveDB();
  if (taskTimers[id]) { clearTimeout(taskTimers[id]); delete taskTimers[id]; }
  res.json({ ok:true });
});

app.post('/api/mint', auth, async (req,res) => {
  const { walletLabel, contract, fn, qty, price, gas, chain } = req.body;
  const wallet = DB.wallets.find(w=>w.label===walletLabel);
  if (!wallet) return res.status(404).json({ error:'Wallet not found' });
  try {
    const txHash = await executeMint({ wallet, contractAddr:contract, fnName:fn||'mint', qty:qty||1, priceETH:price||0, gasGwei:gas||null, chain:chain||wallet.chain });
    wallet.minted=(wallet.minted||0)+(qty||1);
    logActivity('success',`Minted ${qty||1} NFT${qty>1?'s':''}`,wallet.label,txHash,CHAINS[chain||wallet.chain]);
    tg(`✅ *Manual mint success!*\nWallet: *${wallet.label}*\nQty: ${qty||1}\n[View tx](${CHAINS[chain||wallet.chain].ex}${txHash})`);
    res.json({ ok:true, txHash, explorer:CHAINS[chain||wallet.chain].ex+txHash });
  } catch(e) {
    logActivity('fail','Manual mint failed',wallet.label,null,CHAINS[chain||wallet.chain]);
    res.status(500).json({ error:e.reason||e.message||'Mint failed' });
  }
});

app.post('/api/batch', auth, async (req,res) => {
  const { walletLabels, contract, fn, qty, price, gas } = req.body;
  if (!walletLabels?.length) return res.status(400).json({ error:'walletLabels required' });
  res.json({ ok:true, message:`Batch firing across ${walletLabels.length} wallets...` });
  Promise.all(walletLabels.map(async label => {
    const wallet = DB.wallets.find(w=>w.label===label);
    if (!wallet) return { label, status:'error', error:'Wallet not found' };
    try {
      const txHash = await executeMint({ wallet, contractAddr:contract, fnName:fn||'mint', qty:qty||1, priceETH:price||0, gasGwei:gas||null, chain:wallet.chain });
      wallet.minted=(wallet.minted||0)+(qty||1);
      logActivity('success',`Batch minted ${qty||1} NFT${qty>1?'s':''}`,wallet.label,txHash,CHAINS[wallet.chain]);
      return { label, status:'success', txHash };
    } catch(e) {
      logActivity('fail','Batch mint failed',label,null,CHAINS[wallet?.chain]);
      return { label, status:'error', error:e.message };
    }
  })).then(results => {
    saveDB();
    const ok=results.filter(r=>r.status==='success').length, fail=results.filter(r=>r.status!=='success').length;
    tg(`🔁 *Batch complete*\n✅ Success: ${ok}\n❌ Failed: ${fail}\n\n${results.map(r=>`${r.status==='success'?'✅':'❌'} ${r.label}`).join('\n')}`);
  });
});

app.get('/api/activity', auth, (req,res) => res.json(DB.activity.slice(0,100)));

app.get('/api/gas', auth, async (req,res) => {
  try { const r=await axios.get('https://api.etherscan.io/api?module=gastracker&action=gasoracle'); res.json(r.data.result); }
  catch(e) { res.status(500).json({ error:'Failed to fetch gas' }); }
});

app.post('/api/whitelist', auth, async (req,res) => {
  const { contract, address, fn, chain } = req.body;
  try {
    const abi=[{inputs:[{name:'addr',type:'address'}],name:fn||'isWhitelisted',outputs:[{name:'',type:'bool'}],stateMutability:'view',type:'function'}];
    const p=new ethers.JsonRpcProvider(CHAINS[chain||'ethereum'].rpc);
    const c=new ethers.Contract(contract,abi,p);
    const result=await c[fn||'isWhitelisted'](address);
    res.json({ listed:!!result, address, contract });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/pnl', auth, (req,res) => res.json(DB.pnl));
app.post('/api/pnl', auth, (req,res) => {
  const { name, cost, sale, gas } = req.body;
  if (!name) return res.status(400).json({ error:'name required' });
  DB.pnl.unshift({ nm:name, cost:cost||0, sale:sale||0, gas:gas||0, net:(sale||0)-(cost||0)-(gas||0), t:Date.now() });
  saveDB(); res.json({ ok:true });
});
app.delete('/api/pnl/:idx', auth, (req,res) => {
  DB.pnl.splice(parseInt(req.params.idx),1); saveDB(); res.json({ ok:true });
});

// ── Snipers ───────────────────────────────────────────────
app.get('/api/snipers', auth, (req,res) => res.json(DB.snipers));

app.post('/api/snipers', auth, (req,res) => {
  const { label, targetAddress, chain, walletLabel, valueMode, fixedValueETH, maxValueETH, gasBoostPercent } = req.body;
  if (!label||!targetAddress||!chain||!walletLabel) return res.status(400).json({ error:'label, targetAddress, chain and walletLabel are required' });
  if (!CHAINS[chain]) return res.status(400).json({ error:'Unsupported chain' });
  if (!ethers.isAddress(targetAddress)) return res.status(400).json({ error:'Invalid target address' });
  const wallet = DB.wallets.find(w => w.label===walletLabel);
  if (!wallet) return res.status(404).json({ error:'Firing wallet not found' });
  const sniper = {
    id: Date.now(), label, targetAddress, chain, walletLabel,
    valueMode: valueMode==='fixed' ? 'fixed' : 'copy',
    fixedValueETH: parseFloat(fixedValueETH)||0,
    maxValueETH: (maxValueETH!==undefined && maxValueETH!==null && maxValueETH!=='') ? parseFloat(maxValueETH) : null,
    gasBoostPercent: gasBoostPercent!==undefined ? parseInt(gasBoostPercent) : 20,
    active: true, hits:0, fails:0, lastFiredAt:null, createdAt: Date.now(),
  };
  DB.snipers.push(sniper); saveDB();
  ensureChainWatcher(chain);
  tg(`🎯 *Sniper armed!*\nLabel: *${label}*\nWatching: \`${targetAddress.slice(0,10)}...\`\nChain: ${CHAINS[chain].name}\nFiring wallet: *${walletLabel}*`);
  res.json({ ok:true, sniper });
});

app.patch('/api/snipers/:id', auth, (req,res) => {
  const id = parseInt(req.params.id);
  const sniper = DB.snipers.find(s => s.id===id);
  if (!sniper) return res.status(404).json({ error:'Not found' });
  const prevChain = sniper.chain;
  ['label','walletLabel','valueMode','fixedValueETH','maxValueETH','gasBoostPercent','active','chain'].forEach(k => {
    if (req.body[k]!==undefined) sniper[k]=req.body[k];
  });
  saveDB();
  if (sniper.active) ensureChainWatcher(sniper.chain);
  teardownChainWatcherIfIdle(prevChain);
  if (prevChain!==sniper.chain) teardownChainWatcherIfIdle(prevChain);
  res.json({ ok:true, sniper });
});

app.delete('/api/snipers/:id', auth, (req,res) => {
  const id = parseInt(req.params.id);
  const idx = DB.snipers.findIndex(s => s.id===id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  const chain = DB.snipers[idx].chain;
  DB.snipers.splice(idx,1); saveDB();
  delete sniperSeenTx[id];
  teardownChainWatcherIfIdle(chain);
  res.json({ ok:true });
});

app.get('/health', (req,res) => res.json({ status:'ok', uptime:Math.floor(process.uptime()), tasks:DB.tasks.filter(t=>t.status==='waiting').length }));
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`🚀 GhostMint running on port ${PORT}`);
  log(`📊 Wallets: ${DB.wallets.length} | Tasks: ${DB.tasks.length}`);
});

process.on('unhandledRejection', e => log('Rejection: '+e.message));
process.on('uncaughtException',  e => log('Exception: '+e.message));
