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
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
  catch { return { wallets:[], tasks:[], activity:[], pnl:[] }; }
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

// ── Telegram ──────────────────────────────────────────────
let bot = null;
function tg(msg) {
  if (bot && CHAT_ID) bot.sendMessage(CHAT_ID, msg, { parse_mode:'Markdown' }).catch(e => log('TG: '+e.message));
}

if (BOT_TOKEN) {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });
  log('Telegram bot started');

  bot.onText(/\/start|\/help/, () => {
    tg(`👻 *GhostMint Bot*\n\n*Commands:*\n/wallets — list wallets\n/tasks — scheduled tasks\n/activity — recent mints\n/gas — live gas prices\n/stats — overview\n/canceltask <id> — cancel task\n/removewallet <label> — remove wallet\n/mintnow <label> <contract> <qty> <price> <chain> — instant mint`);
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

// ── Copy Mint / Wallet Watcher ────────────────────────────────────────
const watcherProviders = {};
const activeWatchers   = {};

function startWatcher(watcher) {
  if (activeWatchers[watcher.id]) return; // already running
  const chain = CHAINS[watcher.chain] || CHAINS.ethereum;
  try {
    // Use WebSocket-compatible provider via polling fallback
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    log(`Starting watcher for ${watcher.targetAddress} on ${chain.name}`);

    // Poll every 12 seconds for new transactions from target wallet
    const interval = setInterval(async () => {
      try {
        const block = await provider.getBlockNumber();
        const txList = await provider.getLogs({
          fromBlock: block - 1,
          toBlock: 'latest',
        });

        // Get latest block transactions
        const fullBlock = await provider.getBlock(block, true);
        if (!fullBlock || !fullBlock.transactions) return;

        for (const tx of fullBlock.transactions) {
          if (!tx || !tx.from) continue;
          if (tx.from.toLowerCase() !== watcher.targetAddress.toLowerCase()) continue;
          if (!tx.to) continue; // contract creation, skip
          if (watcher.lastTxHash && watcher.lastTxHash === tx.hash) continue;

          // Check if this looks like a mint (has value or matches known mint fn signatures)
          const isMint = tx.data && (
            tx.data.startsWith('0x1249c58b') || // mint()
            tx.data.startsWith('0xa0712d68') || // mint(uint256)
            tx.data.startsWith('0x40d097c3') || // safeMint
            tx.data.startsWith('0x6a627842') || // mint(address)
            tx.data.startsWith('0x84bb1e42') || // mint(address,uint256)
            tx.data.length > 10                  // any contract call
          );

          if (!isMint) continue;

          log(`Copy mint triggered! Target ${watcher.targetAddress} minted at ${tx.to}`);
          watcher.lastTxHash = tx.hash;
          DB.copymint = DB.copymint || [];
          saveDB();

          tg(`👁 *Copy Mint Detected!*\nTarget: \`${watcher.targetAddress.slice(0,10)}...\`\nContract: \`${tx.to.slice(0,10)}...\`\nFiring your wallet now...`);

          // Fire mint from all linked wallets
          const linkedWallets = watcher.walletLabels.map(l => DB.wallets.find(w => w.label === l)).filter(Boolean);
          for (const wallet of linkedWallets) {
            try {
              // Mirror the exact transaction
              const pk       = decryptPK(wallet.encryptedKey);
              const signer   = new ethers.Wallet(pk, provider);
              const mirrorTx = {
                to:    tx.to,
                data:  tx.data,
                value: tx.value,
              };
              if (watcher.gasGwei) mirrorTx.gasPrice = ethers.parseUnits(watcher.gasGwei.toString(), 'gwei');
              const sentTx = await signer.sendTransaction(mirrorTx);
              await sentTx.wait();
              wallet.minted = (wallet.minted || 0) + 1;
              logActivity('success', `Copy minted from ${watcher.targetAddress.slice(0,8)}...`, wallet.label, sentTx.hash, chain);
              tg(`✅ *Copy Mint SUCCESS!*\nWallet: *${wallet.label}*\nContract: \`${tx.to.slice(0,10)}...\`\n[View tx](${chain.ex}${sentTx.hash})`);
              log(`Copy mint success: ${sentTx.hash}`);
            } catch(e) {
              logActivity('fail', `Copy mint failed from ${watcher.targetAddress.slice(0,8)}...`, wallet.label, null, chain);
              tg(`❌ *Copy Mint FAILED*\nWallet: *${wallet.label}*\nError: ${(e.reason||e.message||'Unknown').slice(0,100)}`);
              log(`Copy mint failed: ${e.message}`);
            }
          }
          saveDB();
        }
      } catch(e) {
        // Silent — polling errors are common
      }
    }, 12000);

    activeWatchers[watcher.id] = interval;
    log(`Watcher ${watcher.id} active — polling every 12s`);
  } catch(e) {
    log(`Watcher start error: ${e.message}`);
  }
}

function stopWatcher(id) {
  if (activeWatchers[id]) {
    clearInterval(activeWatchers[id]);
    delete activeWatchers[id];
    log(`Watcher ${id} stopped`);
  }
}

// Restore active watchers on boot
if (!DB.copymint) DB.copymint = [];
DB.copymint.filter(w => w.active).forEach(startWatcher);
log(`Restored ${DB.copymint.filter(w=>w.active).length} copy mint watchers`);

// Telegram copy mint commands
if (bot) {
  bot.onText(/\/watchers/, () => {
    const list = (DB.copymint||[]);
    if (!list.length) return tg('No copy mint watchers. Add via web dashboard.');
    tg(`👁 *Copy Mint Watchers (${list.length})*\n\n` + list.map((w,i) =>
      `${i+1}. *${w.name}*\nTarget: \`${w.targetAddress.slice(0,10)}...\`\nWallets: ${w.walletLabels.join(', ')}\nStatus: ${w.active?'🟢 Active':'🔴 Stopped'}\nID: \`${w.id}\``
    ).join('\n\n'));
  });

  bot.onText(/\/stopwatcher (.+)/, (msg, match) => {
    const id = parseInt(match[1]);
    const w  = (DB.copymint||[]).find(x => x.id===id);
    if (!w) return tg('Watcher not found. Use /watchers.');
    w.active = false; stopWatcher(id); saveDB();
    tg(`✅ Watcher *${w.name}* stopped.`);
  });

  bot.onText(/\/startwatcher (.+)/, (msg, match) => {
    const id = parseInt(match[1]);
    const w  = (DB.copymint||[]).find(x => x.id===id);
    if (!w) return tg('Watcher not found. Use /watchers.');
    w.active = true; startWatcher(w); saveDB();
    tg(`✅ Watcher *${w.name}* started.`);
  });
}

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

// ── Copy Mint API ─────────────────────────────────────────
app.get('/api/copymint', auth, (req,res) => res.json(DB.copymint||[]));

app.post('/api/copymint', auth, (req,res) => {
  const { name, targetAddress, walletLabels, chain, gasGwei } = req.body;
  if (!name||!targetAddress||!walletLabels?.length) return res.status(400).json({ error:'name, targetAddress and walletLabels required' });
  if (!targetAddress.startsWith('0x')) return res.status(400).json({ error:'Invalid target address' });
  if (!DB.copymint) DB.copymint = [];
  const watcher = { id:Date.now(), name, targetAddress, walletLabels, chain:chain||'ethereum', gasGwei:gasGwei||null, active:true, lastTxHash:null, createdAt:Date.now() };
  DB.copymint.push(watcher); saveDB();
  startWatcher(watcher);
  tg(`👁 *Copy Mint Watcher started!*\nName: *${name}*\nTarget: \`${targetAddress.slice(0,10)}...\`\nWallets: ${walletLabels.join(', ')}\nChain: ${CHAINS[chain]?.name||chain}`);
  res.json({ ok:true, watcher });
});

app.patch('/api/copymint/:id', auth, (req,res) => {
  const id  = parseInt(req.params.id);
  const w   = (DB.copymint||[]).find(x=>x.id===id);
  if (!w) return res.status(404).json({ error:'Watcher not found' });
  const { active } = req.body;
  w.active = active;
  if (active) startWatcher(w); else stopWatcher(id);
  saveDB();
  tg(`👁 Watcher *${w.name}* ${active?'started':'stopped'}.`);
  res.json({ ok:true });
});

app.delete('/api/copymint/:id', auth, (req,res) => {
  const id  = parseInt(req.params.id);
  const idx = (DB.copymint||[]).findIndex(x=>x.id===id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  stopWatcher(id);
  DB.copymint.splice(idx,1); saveDB();
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
