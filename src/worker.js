// Push the Boulder: Cloudflare Worker
//
//   /api/live?mint=<address>  latest trades, market cap and supply (served by one shared tracker per coin)
//   /api/rpc                  locked-down pass-through to your Solana RPC for wallet balances and trading
//   everything else           the website in /public
//
// Needs one secret in Cloudflare: RPC_URL (your Helius link). It never reaches the browser.

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
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
    if (url.pathname === '/api/rpc') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      return cors(await rpcProxy(request, env));
    }
    return env.ASSETS.fetch(request);
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
    };
  }

  async fetch(request) {
    await this.load();
    const mint = new URL(request.url).searchParams.get('mint');
    if (mint && this.s.mint !== mint) { this.s.mint = mint; this.s.trades = []; this.s.seen = []; this.s.lastSig = ''; this.s.mc = 0; }
    this.lastView = Date.now();
    // First visit or a stale tracker: refresh right now so the page gets real numbers immediately
    if (!this.s.updated || Date.now() - this.s.updated > 10_000) await this.refreshOnce();
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + POLL_MS);
    const { mint: m, mc, supply, solUsd, trades, updated, lastError } = this.s;
    return json({ mint: m, mc, supply, solUsd, trades, updated, error: !updated && lastError ? lastError : undefined, warning: lastError || undefined });
  }

  async alarm() {
    await this.load();
    if (Date.now() - this.lastView > IDLE_STOP_MS) return;   // nobody watching: stop polling (and stop using credits)
    await this.refreshOnce();
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

      const parsed = [];
      for (let i = 0; i < toParse.length; i += 4) {               // 4 at a time
        const batch = await Promise.all(toParse.slice(i, i + 4).map(sig => parseTrade(env, sig, s.mint).catch(() => null)));
        parsed.push(...batch);
      }
      const newTrades = parsed.filter(Boolean).map(t => ({ ...t, mc: s.solUsd && s.supply ? t.priceSol * s.supply * s.solUsd : 0 }));
      if (newTrades.length) {
        s.trades = [...newTrades, ...s.trades].sort((a, b) => (b.slot - a.slot) || 0).slice(0, KEEP_TRADES);
        const latest = s.trades.find(t => t.mc > 0);
        if (latest) s.mc = latest.mc;
      }
      if (!s.mc) { const d = await dexMarketCap(s.mint).catch(() => 0); if (d) s.mc = d; }

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
  if (!env.RPC_URL) throw new Error('RPC_URL secret is not set in Cloudflare');
  const r = await fetch(env.RPC_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.status === 429) throw new Error('Solana RPC rate limit hit (429)');
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
  if (!env.RPC_URL) return json({ error: 'RPC_URL secret is not set in Cloudflare' }, 500);
  const r = await fetch(env.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
}

// A transaction becomes a buy or sell from the point of view of the wallet that paid for it.
// Works for the pump.fun bonding curve, PumpSwap after migration, and routers like Jupiter.
async function parseTrade(env, sig, mint) {
  const tx = await rpc(env, 'getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx || !tx.meta || tx.meta.err) return null;
  const payer = tx.transaction.message.accountKeys[0];
  const payerKey = typeof payer === 'string' ? payer : payer.pubkey;
  const sum = (arr, m) => (arr || []).filter(b => b.mint === m && b.owner === payerKey)
    .reduce((a, b) => a + Number(b.uiTokenAmount.uiAmount || 0), 0);
  const dTok = sum(tx.meta.postTokenBalances, mint) - sum(tx.meta.preTokenBalances, mint);
  if (Math.abs(dTok) < 1e-6) return null;
  const dSol = (tx.meta.postBalances[0] - tx.meta.preBalances[0] + tx.meta.fee) / 1e9
    + (sum(tx.meta.postTokenBalances, WSOL) - sum(tx.meta.preTokenBalances, WSOL));
  const type = dTok > 0 ? 'buy' : 'sell';
  if (type === 'buy' && dSol >= -0.00001) return null;   // tokens arrived without SOL leaving: a transfer
  if (type === 'sell' && dSol <= 0.00001) return null;   // tokens left without SOL arriving: a transfer
  const sol = Math.abs(dSol), tokens = Math.abs(dTok);
  return { sig, type, sol, tokens, priceSol: sol / tokens, wallet: payerKey, time: tx.blockTime || 0, slot: tx.slot || 0 };
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

async function dexMarketCap(mint) {
  const r = await fetch('https://api.dexscreener.com/tokens/v1/solana/' + mint);
  const pairs = await r.json();
  if (!Array.isArray(pairs) || !pairs.length) return 0;
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  return Number(pairs[0].marketCap || pairs[0].fdv || 0);
}
