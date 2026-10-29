// Push the Boulder: Cloudflare Worker
//
//   /api/live?mint=<address>  latest trades, market cap and supply (served by one shared tracker per coin)
//   /api/rpc                  locked-down pass-through to your Solana RPC for wallet balances and trading
//   everything else           the website in /public
//
// Uses the secret RPC_URL (your Helius link) if set; otherwise falls back to Solana's free public RPC,
// which works for light traffic but can be rate-limited. The key never reaches the browser.

import { BurnLog, scheduledBurn } from './burnbot.js';
export { BurnLog };

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const rpcUrl = env => env.RPC_URL || PUBLIC_RPC;
const WSOL = 'So11111111111111111111111111111111111111112';
const RPC_ALLOWED = new Set(['getBalance', 'getTokenAccountsByOwner', 'getTokenSupply', 'getLatestBlockhash',
  'sendTransaction', 'getSignatureStatuses', 'getSignaturesForAddress', 'getAccountInfo']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/live') {
      const mint = url.searchParams.get('mint') || '';
      if (!MINT_RE.test(mint)) return cors(json({ error: 'Invalid mint' }, 400));
      if (!env.LIVE) return cors(json({ error: 'The LIVE Durable Object binding is missing from wrangler.jsonc' }, 500));
      const stub = env.LIVE.get(env.LIVE.idFromName(mint));
      const res = await stub.fetch('https://tracker/snapshot?mint=' + mint);
      return cors(new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    }
    if (url.pathname === '/api/burns') {
      // Public burn history for the website (read-only)
      if (!env.BURNS) return cors(json({ error: 'The burn log isn\u2019t set up' }, 500));
      const res = await env.BURNS.get(env.BURNS.idFromName('main')).fetch('https://burns/list');
      return cors(new Response(res.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
    }
    if (url.pathname === '/api/rpc') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      return cors(await rpcProxy(request, env));
    }
    return env.ASSETS.fetch(request);
  },
  // Every hour ("triggers" in wrangler.jsonc): claim creator fees, buy the coin back, burn it
  async scheduled(event, env, ctx) {
    ctx.waitUntil(scheduledBurn(env));
  },
};

// ---------- One live tracker per coin ----------
// Wakes when someone views the site, checks the chain every 2.5 s, and goes to sleep a minute after the last viewer leaves.
const POLL_MS = 2500;
const IDLE_STOP_MS = 60_000;
const SUPPLY_EVERY_MS = 20_000;
const PRICE_EVERY_MS = 60_000;
const MAX_TX_PER_CYCLE = 8;     // keeps each check small and fast
const KEEP_TRADES = 50;

export class LiveCoin {
  constructor(state, env) {
    this.state = state; this.env = env;
    this.s = null;              // in-memory copy of the tracker state
    this.lastView = 0;
    this.busy = null;
  }

  async load() {
    if (this.s) return;
    this.s = (await this.state.storage.get('s')) || {
      mint: '', trades: [], seen: [], lastSig: '', mc: 0, supply: 0, solUsd: 0,
      nextSupply: 0, nextPrice: 0, updated: 0, lastError: '',
      burns: [], burnedTracked: 0, histDone: false, histComplete: false, histNext: 0,
      day: '', board: {}, dayUsd: 0, mcHist: [], vol24: 0, nextVol: 0,
    };
  }

  async fetch(request) {
    await this.load();
    const mint = new URL(request.url).searchParams.get('mint');
    if (mint && this.s.mint !== mint) {
      Object.assign(this.s, { mint, trades: [], seen: [], lastSig: '', mc: 0, burns: [], burnedTracked: 0, histDone: false, histComplete: false, histNext: 0,
                              day: '', board: {}, dayUsd: 0, mcHist: [], vol24: 0, nextVol: 0 });
    }
    this.lastView = Date.now();
    // First visit or a stale tracker: refresh right now so the page gets real numbers immediately
    if (!this.s.updated || Date.now() - this.s.updated > 10_000) await this.refreshOnce();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + POLL_MS);
    const { mint: m, mc, supply, solUsd, trades, updated, lastError, burns, burnedTracked, histComplete } = this.s;
    const wantHist = new URL(request.url).searchParams.get('hist') === '1';
    const board = Object.entries(this.s.board || {}).map(([wallet, [sol, n]]) => ({ wallet, sol, n })).sort((a, b) => b.sol - a.sol).slice(0, 10);
    return json({ mint: m, mc, supply, solUsd, trades, updated, burns: (burns || []).slice(0, 12), burnedTracked: burnedTracked || 0, histComplete: !!histComplete,
                  board, dayUsd: this.s.dayUsd || 0, vol24: this.s.vol24 || 0, mcHist: wantHist ? (this.s.mcHist || []) : undefined,
                  error: !updated && lastError ? lastError : undefined, warning: lastError || undefined });
  }

  async alarm() {
    await this.load();
    if (Date.now() - this.lastView > IDLE_STOP_MS) return;   // nobody watching: stop polling (and stop using credits)
    this.fromAlarm = true;
    await this.refreshOnce();
    this.fromAlarm = false;
    await this.state.storage.setAlarm(Date.now() + POLL_MS);
  }

  refreshOnce() {
    if (!this.busy) this.busy = this.refresh().finally(() => { this.busy = null; });
    return this.busy;
  }

  async refresh() {
    const s = this.s, env = this.env, now = Date.now();
    if (!s.mint) return;
    try {
      if (now >= s.nextPrice || !s.solUsd) { const p = await solPrice(); if (p) s.solUsd = p; s.nextPrice = now + PRICE_EVERY_MS; }
      if (now >= s.nextSupply || !s.supply) {
        const v = (await rpc(env, 'getTokenSupply', [s.mint])).value;
        s.supply = Number(v.amount) / 10 ** v.decimals; s.nextSupply = now + SUPPLY_EVERY_MS;
      }

      const opts = { limit: 25 };
      if (s.lastSig) opts.until = s.lastSig;
      const sigs = await rpc(env, 'getSignaturesForAddress', [s.mint, opts]);
      if (sigs.length) s.lastSig = sigs[0].signature;
      const seen = new Set(s.seen);
      const fresh = sigs.filter(x => !x.err && !seen.has(x.signature)).map(x => x.signature);
      fresh.forEach(sig => seen.add(sig));
      const toParse = fresh.slice(0, MAX_TX_PER_CYCLE);           // newest first

      const parsed = [], foundBurns = [];
      for (let i = 0; i < toParse.length; i += 4) {               // 4 at a time
        const batch = await Promise.all(toParse.slice(i, i + 4).map(sig => inspectTx(env, sig, s.mint, s.solUsd).catch(() => null)));
        batch.forEach(r => { parsed.push(r ? r.trade : null); if (r && r.burn) foundBurns.push(r.burn); });
      }
      addBurns(s, foundBurns);
      // once per coin: look up its past burns, so the list isn't empty just because nobody was watching when they happened
      // (run from the background poll, so a visitor's first page load never waits on it)
      if (this.fromAlarm && !s.histDone && now >= (s.histNext || 0)) await burnHistory(env, s).catch(() => { s.histNext = now + 3_600_000; });
      // Market cap from each trade's price. Tiny trades (fees dominate) and wild outliers are not trusted for price;
      // they still count as buys/sells for the game, they just don't move the market cap.
      const toMc = t => (s.supply ? (t.priceUsd ? t.priceUsd * s.supply : s.solUsd ? t.priceSol * s.supply * s.solUsd : 0) : 0);
      const pool = [...parsed.filter(Boolean), ...s.trades].filter(t => t.sol >= 0.01).map(toMc).filter(v => v > 0).sort((x, y) => x - y);
      const ref = pool.length ? pool[Math.floor(pool.length / 2)] : 0;
      const newTrades = parsed.filter(Boolean).map(t => {
        const v = toMc(t);
        const ok = v > 0 && t.sol >= 0.01 && (!ref || (v > ref * 0.4 && v < ref * 2.5));
        return { ...t, mc: ok ? v : 0 };
      });
      if (newTrades.length) {
        s.trades = [...newTrades, ...s.trades].sort((a, b) => (b.slot - a.slot) || 0).slice(0, KEEP_TRADES);
        const latest = s.trades.find(t => t.mc > 0);
        if (latest) s.mc = latest.mc;
      }
      if (!s.mc) { const d = await dexMarketCap(s.mint).catch(() => 0); if (d) s.mc = d; }
      // today's pushers (UTC day): total SOL bought per wallet, and today's trading volume
      const today = new Date(now).toISOString().slice(0, 10);
      if (s.day !== today) { s.day = today; s.board = {}; s.dayUsd = 0; }
      for (const t of newTrades) {
        s.dayUsd = (s.dayUsd || 0) + (t.usd || (s.solUsd ? t.sol * s.solUsd : 0));
        if (t.type === 'buy' && t.wallet) { const e = s.board[t.wallet] || [0, 0]; e[0] += t.sol; e[1] += 1; s.board[t.wallet] = e; }
      }
      const wallets = Object.keys(s.board);
      if (wallets.length > 200) {                                     // keep the 150 biggest so the tracker's storage stays small
        const keep = new Set(wallets.sort((a, b) => s.board[b][0] - s.board[a][0]).slice(0, 150));
        for (const w of wallets) if (!keep.has(w)) delete s.board[w];
      }
      // market cap once a minute, last 6 hours, for the chart
      if (s.mc) {
        const minute = Math.floor(now / 60000) * 60000, h = s.mcHist || (s.mcHist = []);
        if (h.length && h[h.length - 1][0] === minute) h[h.length - 1][1] = Math.round(s.mc);
        else h.push([minute, Math.round(s.mc)]);
        while (h.length && h[0][0] < now - 6 * 3_600_000) h.shift();
      }
      if (now >= (s.nextVol || 0)) { s.nextVol = now + 120_000; const v = await dexVolume24(s.mint).catch(() => 0); if (v) s.vol24 = v; }

      s.seen = [...seen].slice(-400);
      s.updated = now; s.lastError = '';
      await this.state.storage.put('s', s);
    } catch (e) {
      s.lastError = String(e.message || e).slice(0, 200);
    }
  }
}

// ---------- helpers ----------
function cors(res) {
  const r = new Response(res.body, res);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return r;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function rpc(env, method, params) {
  const r = await fetch(rpcUrl(env), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.status === 429 || r.status === 403) throw new Error('Solana RPC refused the request (' + r.status + ')' + (env.RPC_URL ? '' : ': add your Helius link as the RPC_URL secret'));
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}

async function rpcProxy(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await request.text();
  if (body.length > 20000) return json({ error: 'Request too large' }, 413);
  let msg; try { msg = JSON.parse(body); } catch { return json({ error: 'Bad JSON' }, 400); }
  if (Array.isArray(msg) || !RPC_ALLOWED.has(msg.method)) return json({ error: 'Method not allowed' }, 403);
  const r = await fetch(rpcUrl(env), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
}

// A transaction becomes a buy or sell from the point of view of the wallet that paid for it.
// Works for the pump.fun bonding curve, PumpSwap after migration, and routers like Jupiter.
// Quote-token prices (e.g. wrapped BTC) for valuing trades on Custom Pair coins; cached for a minute
const quotePrices = new Map();
async function tokenUsd(m) {
  const hit = quotePrices.get(m);
  if (hit && Date.now() - hit.at < 60000) return hit.usd;
  let usd = 0;
  try {
    const j = await (await fetch('https://lite-api.jup.ag/price/v3?ids=' + m)).json();
    const v = j[m] || j.data?.[m];
    usd = Number(v?.usdPrice || v?.price) || 0;
  } catch {}
  quotePrices.set(m, { usd, at: Date.now() });
  return usd;
}

// Reads one transaction for a coin: a burn (if any of the coin was destroyed) and a trade (if the signer bought or sold)
async function inspectTx(env, sig, mint, solUsd = 0) {
  const tx = await rpc(env, 'getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx || !tx.meta || tx.meta.err) return null;
  return { burn: burnInTx(tx, sig, mint), trade: await tradeFromTx(tx, sig, mint, solUsd).catch(() => null) };
}

// A burn is any transaction where the coin's total across every wallet goes down: tokens were destroyed, not moved
function burnInTx(tx, sig, mint) {
  const total = arr => (arr || []).filter(b => b.mint === mint).reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount || 0), 0);
  const before = total(tx.meta.preTokenBalances), gone = before - total(tx.meta.postTokenBalances);
  if (!(gone > Math.max(1e-6, before * 1e-9))) return null;
  return { sig, amount: gone, time: tx.blockTime || 0, slot: tx.slot || 0 };
}

function addBurns(s, list) {
  if (!list.length) return;
  const have = new Set((s.burns || []).map(b => b.sig));
  for (const b of list) if (!have.has(b.sig)) { s.burns = [b, ...(s.burns || [])]; s.burnedTracked = (s.burnedTracked || 0) + b.amount; have.add(b.sig); }
  s.burns.sort((a, b) => (b.slot - a.slot) || (b.time - a.time));
  s.burns = s.burns.slice(0, 50);
}

// Past burns, looked up once per coin through Helius (the RPC provider in RPC_URL), which can list a coin's burn transactions
async function burnHistory(env, s) {
  s.histNext = Date.now() + 3_600_000;
  let key = '';
  try { const u = new URL(env.RPC_URL || ''); if (/helius/i.test(u.hostname)) key = u.searchParams.get('api-key') || ''; } catch {}
  if (!key) { s.histDone = true; return; }                         // other providers: burns are tracked from now on only
  const found = []; let before = '', complete = false;
  for (let page = 0; page < 6; page++) {
    const url = 'https://api.helius.xyz/v0/addresses/' + s.mint + '/transactions?type=BURN&limit=100&api-key=' + key + (before ? '&before=' + before : '');
    const r = await fetch(url);
    const txs = await r.json().catch(() => null);
    if (!r.ok) {
      // Helius searches in windows; when a window has no burns it replies with the signature to keep searching from
      const m = /([1-9A-HJ-NP-Za-km-z]{80,90})/.exec(JSON.stringify(txs || ''));
      if (m && m[1] !== before) { before = m[1]; continue; }
      throw new Error('burn history HTTP ' + r.status);
    }
    if (!Array.isArray(txs)) throw new Error('burn history: unexpected reply');
    if (!txs.length) { complete = true; break; }                    // nothing older: the whole history has been read
    for (const t of txs) {
      // net change of this coin across every account in the transaction; negative means tokens were destroyed
      let net = 0;
      for (const a of t.accountData || []) for (const c of a.tokenBalanceChanges || []) {
        if (c.mint === s.mint && c.rawTokenAmount) net += Number(c.rawTokenAmount.tokenAmount) / 10 ** Number(c.rawTokenAmount.decimals || 0);
      }
      if (net < 0) found.push({ sig: t.signature, amount: -net, time: t.timestamp || 0, slot: t.slot || 0 });
    }
    before = txs[txs.length - 1].signature;
  }
  addBurns(s, found);
  s.histDone = true; s.histComplete = complete;
}

async function tradeFromTx(tx, sig, mint, solUsd = 0) {
  const payer = tx.transaction.message.accountKeys[0];
  const payerKey = typeof payer === 'string' ? payer : payer.pubkey;
  const sum = (arr, m) => (arr || []).filter(b => b.mint === m && b.owner === payerKey)
    .reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount || 0), 0);
  const dTok = sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  if (Math.abs(dTok) < 1e-6) return null;
  const dSol = (tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee) / 1e9
    + (sum(tx.meta.postTokenBalances, WSOL) - sum(tx.meta.preTokenBalances, WSOL));
  // The payer's change in every other token (the quote side, e.g. wrapped BTC on a Bitcoin-paired coin)
  const others = new Set([...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])]
    .filter(b => b.owner === payerKey && b.mint !== mint && b.mint !== WSOL).map(b => b.mint));
  let quoteUsd = dSol * solUsd;
  for (const m of others) {
    const d = sum(tx.meta.postTokenBalances, m) - sum(tx.meta.preTokenBalances, m);
    if (Math.abs(d) > 0) quoteUsd += d * (await tokenUsd(m));
  }
  const type = dTok > 0 ? 'buy' : 'sell';
  if (solUsd > 0) {
    if (type === 'buy' && quoteUsd >= -0.01) return null;   // tokens arrived without value leaving: a transfer
    if (type === 'sell' && quoteUsd <= 0.01) return null;   // tokens left without value arriving: a transfer
  } else if ((type === 'buy' && dSol >= -0.00001) || (type === 'sell' && dSol <= 0.00001)) return null;
  const tokens = Math.abs(dTok);
  const usd = Math.abs(quoteUsd), sol = solUsd > 0 ? usd / solUsd : Math.abs(dSol);   // size in SOL terms, for the game
  return { sig, type, sol, usd, tokens, priceSol: sol / tokens, priceUsd: solUsd > 0 ? usd / tokens : 0, wallet: payerKey, time: tx.blockTime || 0, slot: tx.slot || 0 };
}

async function solPrice() {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const p = Number((await r.json())?.solana?.usd);
    if (p > 0) return p;
  } catch {}
  try {
    const r = await fetch('https://lite-api.jup.ag/price/v3?ids=' + WSOL);
    const j = await r.json();
    const v = j[WSOL] || j.data?.[WSOL];
    const p = Number(v?.usdPrice || v?.price);
    if (p > 0) return p;
  } catch {}
  return 0;
}

async function dexVolume24(mint) {
  const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mint);
  const pairs = await r.json();
  if (!Array.isArray(pairs) || !pairs.length) return 0;
  return pairs.reduce((a, p) => a + Number(p.volume?.h24 || 0), 0);
}

async function dexMarketCap(mint) {
  const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mint);
  const pairs = await r.json();
  if (!Array.isArray(pairs) || !pairs.length) return 0;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return Number(pairs[0].marketCap || pairs[0].fdv || 0);
}
