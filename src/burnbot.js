// Boulder burn bot: every minute, buy the coin back with whatever is in the burn wallet and burn what it bought.
// Once an hour it also tries to claim creator fees first.
//
// Settings live in wrangler.jsonc ("vars"); the wallet key is a Cloudflare secret named BURN_KEY.
// Safety rules, checked on every run:
//   - it only spends SOL it just claimed (plus anything left over from earlier small claims), never the rest of the wallet;
//     with BURN_SPEND_ALL = "1" (for a wallet that holds nothing but fees) it spends everything above the reserve,
//     which includes the 0.5% site fee from trades on the website
//   - it only burns the tokens it just bought, never other tokens the wallet holds
//   - every transaction is checked before signing: this wallet must be the only signer, and only known programs may run
//   - every transaction is simulated first; if the wallet would lose more SOL than planned, it refuses to send
//   - set BURN_PAUSED to "1" to stop it instantly

const PORTAL = 'https://pumpportal.fun/api/trade-local';
const LAMPORTS = 1e9;
const PROGRAMS = {
  '11111111111111111111111111111111': 'System',
  'ComputeBudget111111111111111111111111111111': 'Compute budget',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token-2022',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated token account',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': 'PumpSwap',
};
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

// ---------- settings ----------
function settings(env) {
  const num = (v, d) => (v === undefined || v === '' || isNaN(Number(v)) ? d : Number(v));
  return {
    mint: (env.BURN_MINT || '').trim(),
    paused: String(env.BURN_PAUSED || '0') === '1',
    spendAll: String(env.BURN_SPEND_ALL || '0') === '1',   // dedicated burn wallet: burn everything above the reserve (creator fees + site fees)
    minClaimSol: num(env.BURN_MIN_CLAIM_SOL, 0.005),   // don't bother claiming less than this
    minBuySol: num(env.BURN_MIN_BUY_SOL, 0.01),        // smaller amounts wait and add up until the next run
    gasSol: num(env.BURN_GAS_SOL, 0.001),              // kept back from each run's fees to pay network fees
    reserveSol: num(env.BURN_RESERVE_SOL, 0.02),       // the wallet never drops below this
    maxBuySol: num(env.BURN_MAX_BUY_SOL, 25),          // hard cap on any single buy
    slippage: num(env.BURN_SLIPPAGE_PCT, 15),
    priorityFee: num(env.BURN_PRIORITY_FEE_SOL, 0.00005),
    extraPrograms: String(env.BURN_EXTRA_PROGRAMS || '').split(/[\s,]+/).filter(Boolean),
  };
}

// ---------- base58 ----------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n; for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('Not base58'); n = n * 58n + BigInt(i); }
  const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return new Uint8Array(out);
}
const b64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = str => Uint8Array.from(atob(str), c => c.charCodeAt(0));
const b64url = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---------- the wallet key ----------
async function loadKeypair(secret) {
  const raw = secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : b58decode(secret.trim());
  if (raw.length !== 64) throw new Error('BURN_KEY must be a 64-byte Solana secret key (base58 or a JSON array)');
  const seed = raw.slice(0, 32), pub = raw.slice(32);
  let key;
  try { key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub) }, { name: 'Ed25519' }, false, ['sign']); }
  catch (e) { throw new Error('BURN_KEY looks damaged: its public and private halves don\u2019t match'); }
  // Make sure the public half really belongs to the private half before trusting it
  const test = new TextEncoder().encode('boulder-burn-bot');
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, test));
  const pubKey = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', pubKey, sig, test))) throw new Error('BURN_KEY looks damaged: its public and private halves don\u2019t match');
  return { key, pub, address: b58encode(pub) };
}

// ---------- Solana RPC ----------
async function rpc(env, method, params) {
  if (!env.RPC_URL) throw new Error('RPC_URL secret is not set');
  const r = await fetch(env.RPC_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + (j.error.message || 'RPC error'));
  return j.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getBalance = async (env, addr) => (await rpc(env, 'getBalance', [addr, { commitment: 'confirmed' }])).value;

async function tokenHolding(env, owner, mint) {
  const res = await rpc(env, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  let best = null;
  for (const a of res.value) {
    const amt = BigInt(a.account.data.parsed.info.tokenAmount.amount);
    if (!best || amt > best.amount) best = { address: a.pubkey, program: a.account.owner, amount: amt, decimals: a.account.data.parsed.info.tokenAmount.decimals };
  }
  return best || { address: null, program: null, amount: 0n, decimals: 0 };
}

async function confirm(env, sig, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2500);
    const st = (await rpc(env, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }])).value[0];
    if (st && st.err) throw new Error('Transaction failed on-chain: ' + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
  }
  throw new Error('Not confirmed in time: https://solscan.io/tx/' + sig);
}

// ---------- reading and checking a transaction before signing it ----------
function compact(b, o) { let v = 0, s = 0, x; do { x = b[o++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [v, o]; }
export function parseTx(bytes) {
  let [nSig, o] = compact(bytes, 0);
  const sigStart = o; o += 64 * nSig;
  const msg = bytes.subarray(o);
  let p = (msg[0] & 0x80) ? 1 : 0;
  const header = { required: msg[p], roSigned: msg[p + 1], roUnsigned: msg[p + 2] }; p += 3;
  let nKeys; [nKeys, p] = compact(msg, p);
  const keys = []; for (let i = 0; i < nKeys; i++) keys.push(b58encode(msg.subarray(p + 32 * i, p + 32 * i + 32)));
  p += 32 * nKeys + 32;                                          // skip the recent blockhash
  let nIx; [nIx, p] = compact(msg, p);
  const programs = [];
  for (let i = 0; i < nIx; i++) {
    const prog = msg[p++]; let n; [n, p] = compact(msg, p); p += n; [n, p] = compact(msg, p); p += n;
    programs.push(keys[prog]);                                   // programs always sit in the static keys
  }
  return { nSig, sigStart, msg, header, keys, programs };
}
function checkTx(t, wallet, cfg, label) {
  if (t.nSig !== 1 || t.header.required !== 1 || t.keys[0] !== wallet)
    throw new Error(`${label}: this wallet must be the fee payer and the only signer; refusing to sign`);
  for (const pr of t.programs) if (!PROGRAMS[pr] && !cfg.extraPrograms.includes(pr))
    throw new Error(`${label}: uses a program the bot doesn't recognise (${pr}); refusing to sign. If it's legitimate, add it to BURN_EXTRA_PROGRAMS.`);
}
async function signTx(bytes, kp) {
  const t = parseTx(bytes);
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.key, t.msg));
  const out = new Uint8Array(bytes); out.set(sig, t.sigStart);
  return out;
}
// Simulate first; returns the wallet's SOL change in lamports (negative = spent)
async function simulate(env, signed, wallet, label) {
  const pre = await getBalance(env, wallet);
  const sim = (await rpc(env, 'simulateTransaction', [b64(signed), { encoding: 'base64', sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [wallet] } }])).value;
  if (sim.err) throw new Error(`${label} would fail: ${JSON.stringify(sim.err)} ${(sim.logs || []).slice(-3).join(' | ')}`);
  const post = sim.accounts && sim.accounts[0] ? sim.accounts[0].lamports : pre;
  return post - pre;
}
async function send(env, signed) {
  const sig = await rpc(env, 'sendTransaction', [b64(signed), { encoding: 'base64', skipPreflight: true, maxRetries: 3 }]);
  return confirm(env, sig);
}
async function portal(body, wallet) {
  const r = await fetch(PORTAL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publicKey: wallet, ...body }) });
  if (r.status !== 200) throw new Error(`PumpPortal said ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return new Uint8Array(await r.arrayBuffer());
}

// ---------- building the burn transaction ourselves ----------
function u64le(v) { const b = new Uint8Array(8); let n = BigInt(v); for (let i = 0; i < 8; i++) { b[i] = Number(n & 255n); n >>= 8n; } return b; }
function u32le(v) { return new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]); }
function cat(...parts) { const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
function burnTx({ wallet, tokenAccount, mint, tokenProgram, amount, decimals, blockhash, priorityFee }) {
  const keys = [wallet, tokenAccount, mint, COMPUTE_BUDGET, tokenProgram].map(b58decode);
  if (keys.some(k => k.length !== 32)) throw new Error('Burn: an address is malformed; refusing to build the transaction');
  const units = 60000, microLamports = Math.max(0, Math.round(priorityFee * 1e15 / units));
  const ix = [
    cat([3, 0, 5, 2], u32le(units)),                                         // compute budget: unit limit
    cat([3, 0, 9, 3], u64le(microLamports)),                                 // compute budget: unit price
    cat([4, 3, 1, 2, 0, 10, 15], u64le(amount), [decimals]),                 // token: burnChecked(account, mint, owner)
  ];
  const message = cat([1, 0, 2, 5], ...keys, b58decode(blockhash), [ix.length], ...ix);
  return cat([1], new Uint8Array(64), message);
}

// ---------- one run ----------
export async function runBurn(env, store, opts = {}) {
  const cfg = settings(env);
  const say = (status, extra = {}) => ({ time: new Date().toISOString(), status, ...extra });
  if (cfg.paused) return say('paused');
  if (!cfg.mint) return say('waiting: set BURN_MINT to your coin\u2019s contract address');
  if (!env.BURN_KEY) return say('waiting: add the BURN_KEY secret in Cloudflare');
  const kp = await loadKeypair(env.BURN_KEY);
  const wallet = kp.address;
  const L = x => Math.round(x * LAMPORTS);
  let pending = (await store.getPending()) || 0;                 // lamports claimed earlier but not yet spent
  const result = { wallet, claimSig: null, claimedSol: 0, buySig: null, spentSol: 0, burnSig: null, burned: 0 };

  // 1) Claim creator fees (once an hour), if there's enough to be worth it (no fees yet just means nothing to claim)
  let claimTx = null, gain = 0;
  if (opts.claim !== false) try {
    claimTx = await signTx(await portal({ action: 'collectCreatorFee', priorityFee: cfg.priorityFee }, wallet), kp);
    checkTx(parseTx(claimTx), wallet, cfg, 'Claim');
    gain = await simulate(env, claimTx, wallet, 'Claim');
  } catch (e) {
    if (/refusing/.test(e.message)) throw e;                      // a safety check failed: stop, don't just skip
    result.claimNote = String(e.message).slice(0, 160);
  }
  if (claimTx && gain >= L(cfg.minClaimSol)) {
    const before = await getBalance(env, wallet);
    result.claimSig = await send(env, claimTx);
    const claimed = Math.max(0, (await getBalance(env, wallet)) - before);
    result.claimedSol = claimed / LAMPORTS;
    pending += claimed;
    await store.setPending(pending);
  }

  // 2) Buy back with what was claimed (or, for a dedicated burn wallet, everything above the reserve)
  const balance = await getBalance(env, wallet);
  // a buy costs the amount PLUS trading fees (the 3% holder reward and pump.fun's fees) and, the first time,
  // a small token-account deposit, so the budget leaves room for those and the reserve stays untouched
  const FEE = 1.06, SETUP = L(0.004);
  let budget = cfg.spendAll
    ? Math.min(Math.floor((balance - L(cfg.reserveSol) - L(cfg.gasSol) - SETUP) / FEE), L(cfg.maxBuySol))
    : Math.min(pending - L(cfg.gasSol), Math.floor((balance - L(cfg.reserveSol) - SETUP) / FEE), L(cfg.maxBuySol));
  if (budget < L(cfg.minBuySol)) return say(result.claimSig ? 'claimed; saving up until there\u2019s enough to buy' : 'nothing to claim yet', { ...result, pendingSol: pending / LAMPORTS });
  const amountSol = Math.floor(budget / 1000) / 1e6;             // whole micro-SOL
  const holdingBefore = await tokenHolding(env, wallet, cfg.mint);
  const buyTx = await signTx(await portal({ action: 'buy', mint: cfg.mint, amount: amountSol, denominatedInSol: 'true', slippage: cfg.slippage, priorityFee: cfg.priorityFee, pool: 'auto' }, wallet), kp);
  checkTx(parseTx(buyTx), wallet, cfg, 'Buy');
  const spend = -(await simulate(env, buyTx, wallet, 'Buy'));
  const allowed = L(amountSol) * FEE + SETUP + L(cfg.priorityFee);  // amount, trading fees, new token account deposit, network fees
  if (spend > allowed) throw new Error(`Buy would take ${spend / LAMPORTS} SOL from the wallet, more than the ${amountSol} SOL planned; refusing to send`);
  result.buySig = await send(env, buyTx);
  result.spentSol = amountSol;
  pending = cfg.spendAll ? 0 : Math.max(0, pending - L(amountSol) - L(cfg.gasSol));
  await store.setPending(pending);

  // 3) Burn exactly what was just bought
  let holding = holdingBefore;
  for (let i = 0; i < 6 && holding.amount <= holdingBefore.amount; i++) { await sleep(1500); holding = await tokenHolding(env, wallet, cfg.mint); }
  const bought = holding.amount - holdingBefore.amount;
  if (bought <= 0n) throw new Error('Bought, but the new tokens haven\u2019t shown up yet; they\u2019ll be burned on the next run');
  const { value: { blockhash } } = await rpc(env, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = burnTx({ wallet, tokenAccount: holding.address, mint: cfg.mint, tokenProgram: holding.program, amount: bought, decimals: holding.decimals, blockhash, priorityFee: cfg.priorityFee });
  const signed = await signTx(tx, kp);
  checkTx(parseTx(signed), wallet, cfg, 'Burn');
  const burnCost = -(await simulate(env, signed, wallet, 'Burn'));
  if (burnCost > L(0.001) + L(cfg.priorityFee)) throw new Error('Burn would cost more SOL than expected; refusing to send');
  result.burnSig = await send(env, signed);
  result.burned = Number(bought) / 10 ** holding.decimals;
  try { result.supplyAfter = (await rpc(env, 'getTokenSupply', [cfg.mint])).value.uiAmount; } catch (e) {}
  return say('burned', result);
}

// ---------- the log the website reads, plus leftover SOL between runs ----------
export class BurnLog {
  constructor(state) { this.state = state; }
  async fetch(request) {
    const url = new URL(request.url), st = this.state.storage;
    if (request.method === 'POST' && url.pathname === '/record') {
      const entry = await request.json();
      const log = (await st.get('log')) || [];
      if (entry.status === 'burned') { log.unshift(entry); await st.put('log', log.slice(0, 100)); }
      await st.put('last', entry);
      return new Response('ok');
    }
    // a lock so two runs never overlap and spend the same SOL twice (it expires on its own after 50 s)
    if (url.pathname === '/lock') {
      const now = Date.now(), until = (await st.get('lockUntil')) || 0;
      if (request.method === 'DELETE') { await st.delete('lockUntil'); return new Response('ok'); }
      if (until > now) return new Response('busy');
      await st.put('lockUntil', now + 50_000); return new Response('ok');
    }
    if (url.pathname === '/pending') {
      if (request.method === 'POST') { await st.put('pending', Number(await request.text()) || 0); return new Response('ok'); }
      return new Response(String((await st.get('pending')) || 0));
    }
    const log = (await st.get('log')) || [], last = (await st.get('last')) || null;
    const totals = log.reduce((t, e) => ({ burned: t.burned + (e.burned || 0), spentSol: t.spentSol + (e.spentSol || 0) }), { burned: 0, spentSol: 0 });
    // Public view: what was burned and when, with links; never anything secret
    const pub = e => e && { time: e.time, status: e.status, claimedSol: e.claimedSol, spentSol: e.spentSol, burned: e.burned, supplyAfter: e.supplyAfter, burnSig: e.burnSig, buySig: e.buySig, claimSig: e.claimSig, error: e.error };
    return new Response(JSON.stringify({ burns: log.slice(0, 50).map(pub), totals, count: log.length, lastRun: pub(last) }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

// Called by the schedule: every minute (and with { claim: true } once an hour)
export async function scheduledBurn(env, opts = {}) {
  const stub = env.BURNS.get(env.BURNS.idFromName('main'));
  const store = {
    getPending: async () => Number(await (await stub.fetch('https://burns/pending')).text()) || 0,
    setPending: async v => { await stub.fetch('https://burns/pending', { method: 'POST', body: String(Math.round(v)) }); },
  };
  if ((await (await stub.fetch('https://burns/lock', { method: 'POST' })).text()) !== 'ok') return { status: 'skipped: the previous run is still going' };
  let entry;
  try { entry = await runBurn(env, store, opts); }
  catch (e) { entry = { time: new Date().toISOString(), status: 'error', error: String(e.message || e).slice(0, 300) }; }
  finally { await stub.fetch('https://burns/lock', { method: 'DELETE' }); }
  // quiet minutes with nothing to buy aren't worth a log write; burns, errors and hourly runs are always recorded
  if (entry.status !== 'nothing to claim yet' || opts.claim) await stub.fetch('https://burns/record', { method: 'POST', body: JSON.stringify(entry) });
  return entry;
}
