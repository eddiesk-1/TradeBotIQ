/**
 * TradeBotIQ v4.6x — Extended Edition
 * ============================================================================
 * NEW: Adaptive Reconnect Window (recWind)
 *   - Pre-auth:  random 36–50s between retry attempts (conservative)
 *   - Post-auth: institutional fast mode — 800–1200ms between assets
 *   - recWind alternates randomly within range on every connection cycle
 *   - Auth verified via /api/v3/account ping before any trading begins
 *
 * KEPT from v4.6e (all audit fixes):
 *   - Public endpoints unsigned, signed endpoints Ed25519
 *   - Insertion-order query strings (no alpha sort)
 *   - Trailing stop saved to disk on every update
 *   - Volatility breakout excludes current candle
 *   - S2 volConfirmed fixed
 *   - AI score engine with OB + 5m + CMF + TD + Fib + ATR
 *   - 3-tier cache, --brief, --pine
 *   - 6 strategies, optimizer allocation, equity scaler
 */

import "dotenv/config";
import { createPrivateKey, sign as cryptoSign } from "crypto";
import { writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const TRADING_ACCOUNT = (process.env.TRADING_ACCOUNT || "demo").toLowerCase();
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const IS_LIVE         = TRADING_ACCOUNT === "live" && !PAPER_TRADING;

const CONFIG = {
  assets:           (process.env.ASSETS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,LINKUSDT,PEPEUSDT")
                      .split(",").map(s => s.trim()).filter(Boolean),
  timeframe:        (process.env.TIMEFRAME || "1h").toLowerCase(),
  takeProfitPct:    parseFloat(process.env.TAKE_PROFIT_PCT    || "3.5"),
  stopLossPct:      parseFloat(process.env.STOP_LOSS_PCT      || "1.0"),
  trailingStopPct:  parseFloat(process.env.TRAILING_STOP_PCT  || "1.0"),
  trailingActivate: parseFloat(process.env.TRAILING_ACTIVATE  || "1.0"),
  maxTradesPerDay:  parseInt(process.env.MAX_TRADES_PER_DAY   || "31"),
  maxPositions:     parseInt(process.env.MAX_POSITIONS        || "3"),
  riskPerTrade:     parseFloat(process.env.RISK_PCT           || "1.0"),
  rrRatio:          parseFloat(process.env.RR_RATIO           || "2.0"),
  s1Pct:            parseFloat(process.env.S1_PCT             || "30"),
  s2Pct:            parseFloat(process.env.S2_PCT             || "5"),
  maxTradeUSD:      parseFloat(process.env.MAX_TRADE_SIZE_USD  || "35"),
  minScoreS1:       parseInt(process.env.MIN_SCORE_S1         || "60"),
  minScoreS2:       parseInt(process.env.MIN_SCORE_S2         || "40"),
  minScoreGeneral:  parseInt(process.env.MIN_SCORE_GENERAL    || "50"),
  maxDrawdown:      parseFloat(process.env.MAX_DRAWDOWN_PCT    || "15"),
  paperTrading:     PAPER_TRADING,
  isLive:           IS_LIVE,
  feeRate:          0.001,
  slippagePct:      0.0005,
  apiBase:          IS_LIVE ? "https://api.binance.com" : "https://testnet.binance.vision",
  activeStrategies: (process.env.ACTIVE_STRATEGIES || "all").split(",").map(s => s.trim().toLowerCase()),
  // recWind bounds (seconds)
  recWindMin:       parseInt(process.env.RECWIND_MIN || "36"),
  recWindMax:       parseInt(process.env.RECWIND_MAX || "50"),
};

// ─── Adaptive Reconnect Window (recWind) ──────────────────────────────────────
// Tracks connection state and switches timing modes after successful auth
const CONN = {
  authenticated:  false,   // flips true after /api/v3/account succeeds
  fastMode:       false,   // institutional speed after auth confirmed
  authAttempts:   0,
  lastAuthTime:   null,
  lastRecWind:    null,    // ms of last window used
};

// Returns a random recWind in [min, max] seconds → converted to ms
function randomRecWind() {
  const min = CONFIG.recWindMin * 1000;
  const max = CONFIG.recWindMax * 1000;
  const w   = Math.floor(Math.random() * (max - min + 1)) + min;
  CONN.lastRecWind = w;
  return w;
}

// Inter-asset delay — fast after auth, conservative before
function assetDelay() {
  return CONN.fastMode
    ? Math.floor(Math.random() * 400) + 800   // 800–1200ms institutional
    : Math.floor(Math.random() * 500) + 1200; // 1200–1700ms conservative
}

// Inter-request delay within one asset cycle
function requestDelay() {
  return CONN.fastMode
    ? Math.floor(Math.random() * 100) + 200  // 200–300ms fast
    : Math.floor(Math.random() * 200) + 400; // 400–600ms conservative
}

// ─── Ed25519 Signing ──────────────────────────────────────────────────────────
const privateKeyPem = process.env.BINANCE_PRIVATE_KEY;
const apiKey        = IS_LIVE ? process.env.BINANCE_API_KEY : process.env.BINANCE_DEMO_API_KEY;

if (!privateKeyPem) throw new Error("BINANCE_PRIVATE_KEY not set in Railway Variables");
if (!apiKey)        throw new Error("BINANCE_API_KEY / BINANCE_DEMO_API_KEY not set");

const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });

function signRequest(params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  // Insertion order preserved — Binance requires this
  const qs        = Object.entries(allParams).map(([k,v]) => `${k}=${v}`).join("&");
  const signature = cryptoSign(null, Buffer.from(qs), privateKey).toString("base64url");
  return { qs, signature };
}

// ─── Core HTTP with adaptive retry using recWind ──────────────────────────────
async function binanceRequest(method, path, params = {}, signed = true, retries = 5) {
  let url;
  if (signed) {
    const { qs, signature } = signRequest(params);
    url = `${CONFIG.apiBase}${path}?${qs}&signature=${signature}`;
  } else {
    const qs = Object.entries(params).map(([k,v]) => `${k}=${v}`).join("&");
    url = `${CONFIG.apiBase}${path}${qs ? "?" + qs : ""}`;
  }

  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res  = await fetch(url, {
        method,
        headers: signed
          ? { "X-MBX-APIKEY": apiKey, "Content-Type": "application/json" }
          : {},
      });
      const data = await res.json();
      if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
      return data;
    } catch (err) {
      lastErr = err;
      if (i === retries - 1) break;

      // Use recWind for pre-auth failures, exponential cap for post-auth
      const delay = CONN.authenticated
        ? Math.min(1000 * Math.pow(2, i), 30_000)  // 1s→30s exponential post-auth
        : randomRecWind();                           // 36–50s random pre-auth

      console.log(`   ⟳ Retry ${i+1}/${retries} in ${(delay/1000).toFixed(1)}s — ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── Auth Ping — verifies Ed25519 signing works before trading ────────────────
async function verifyAuth() {
  CONN.authAttempts++;
  try {
    console.log(`   🔐 Auth ping attempt ${CONN.authAttempts}...`);
    await binanceRequest("GET", "/api/v3/account", {}, true, 1);
    CONN.authenticated = true;
    CONN.fastMode      = true;
    CONN.lastAuthTime  = new Date().toISOString();
    console.log(`   ✅ Auth confirmed — switching to FAST MODE (800–1200ms between assets)`);
    console.log(`   🕐 Last recWind used: ${CONN.lastRecWind ? (CONN.lastRecWind/1000).toFixed(1)+"s" : "N/A (first auth)"}`);
    return true;
  } catch (err) {
    CONN.authenticated = false;
    CONN.fastMode      = false;
    const w = randomRecWind();
    console.log(`   ❌ Auth failed: ${err.message}`);
    console.log(`   ⏳ recWind: waiting ${(w/1000).toFixed(1)}s before retry (range ${CONFIG.recWindMin}–${CONFIG.recWindMax}s)`);
    await new Promise(r => setTimeout(r, w));
    return false;
  }
}

// ─── 3-Tier Cache ─────────────────────────────────────────────────────────────
const CACHE = new Map();
const CACHE_TTL = {
  klines:    30_000,
  orderbook: 10_000,
  account:   60_000,
  ticker:    15_000,
  symbols:   86_400_000,
};

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) { entry.stale = true; return entry; }
  return entry;
}
function cacheSet(key, data, ttlKey) {
  CACHE.set(key, { data, ts: Date.now(), ttl: CACHE_TTL[ttlKey] || 30_000, stale: false });
}
function cleanCache() {
  const cutoff = Date.now() - 300_000;
  for (const [k, v] of CACHE.entries()) if (v.ts < cutoff) CACHE.delete(k);
}

// ─── Exchange Helpers ─────────────────────────────────────────────────────────
async function fetchAccountBalance() {
  const cached = cacheGet("account_balance");
  if (cached && !cached.stale) return cached.data;
  const data = await binanceRequest("GET", "/api/v3/account", {}, true);
  const usdt = parseFloat(data.balances?.find(b => b.asset === "USDT")?.free || 0);
  cacheSet("account_balance", usdt, "account");
  return usdt;
}

async function fetchCandles(symbol, interval, limit = 500) {
  const key    = `klines_${symbol}_${interval}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const map  = { "1h":"1h","2h":"2h","4h":"4h","1d":"1d","5m":"5m","15m":"15m" };
  const data = await binanceRequest("GET", "/api/v3/klines",
    { symbol, interval: map[interval] || "1h", limit }, false);

  const candles = data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
  cacheSet(key, candles, "klines");
  return candles;
}

async function fetchOrderBook(symbol, limit = 20) {
  const key    = `ob_${symbol}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const data   = await binanceRequest("GET", "/api/v3/depth", { symbol, limit }, false);
  const bidVol = data.bids.reduce((s,b) => s + parseFloat(b[1]), 0);
  const askVol = data.asks.reduce((s,a) => s + parseFloat(a[1]), 0);
  const imb    = askVol > 0 ? bidVol / askVol : 1;
  const topBid = parseFloat(data.bids[0]?.[0] || 0);
  const topAsk = parseFloat(data.asks[0]?.[0] || 0);
  const spread = topAsk > 0 ? (topAsk - topBid) / topAsk * 100 : 0;
  const result = { bidVol, askVol, imbalance: imb, spread, bullish: imb > 1.15, bearish: imb < 0.85 };
  cacheSet(key, result, "orderbook");
  return result;
}

async function get5mConfirmation(symbol) {
  const key    = `5m_${symbol}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const candles = await fetchCandles(symbol, "5m", 20);
  const closes  = candles.map(c => c.close);
  const vols    = candles.map(c => c.volume);
  const ema8    = calcEMA(closes, 8);
  const ema21   = calcEMA(closes, 21);
  const rsi5m   = calcRSI(closes, 7);
  const avgVol  = vols.slice(-10).reduce((a,b) => a+b, 0) / 10;
  const last    = candles[candles.length-1];
  const prev    = candles[candles.length-2];
  const body    = Math.abs(last.close - last.open);
  const wick    = (last.high - last.low) || 0.0001;
  const result  = {
    bullish:      ema8 > ema21 && rsi5m < 65 && last.close > prev.close,
    bearish:      ema8 < ema21 && rsi5m > 35 && last.close < prev.close,
    volSpike:     vols[vols.length-1] > avgVol * 1.5,
    strongCandle: body / wick > 0.6,
    rsi5m,
  };
  cacheSet(key, result, "klines");
  return result;
}

async function placeMarketOrder(symbol, side, quantity) {
  const qty = formatQty(symbol, quantity);
  return binanceRequest("POST", "/api/v3/order", {
    symbol, side: side.toUpperCase(), type: "MARKET",
    quantity: qty.toFixed(PRECISION[symbol]?.qty || 4),
  }, true);
}

// ─── Symbol Precision ─────────────────────────────────────────────────────────
const PRECISION = {
  BTCUSDT:  { qty:5, price:2, minQty:0.00001 },
  ETHUSDT:  { qty:4, price:2, minQty:0.0001  },
  SOLUSDT:  { qty:2, price:3, minQty:0.01    },
  XRPUSDT:  { qty:1, price:4, minQty:0.1     },
  LINKUSDT: { qty:2, price:3, minQty:0.01    },
  PEPEUSDT: { qty:0, price:8, minQty:1       },
};
function formatQty(symbol, qty) {
  const p       = PRECISION[symbol] || { qty:4, minQty:0.0001 };
  const rounded = parseFloat(qty.toFixed(p.qty));
  return Math.max(rounded, p.minQty);
}

// ─── Files ────────────────────────────────────────────────────────────────────
const LOG_FILE       = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE       = "trades.csv";
const BRIEF_FILE     = "morning-brief.json";
const BALANCE_FILE   = "balance-history.json";
const STATE_FILE     = "bot-state.json";
const SIG_CACHE_FILE = "signal-cache.json";
const CSV_HEADERS    = "Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,USD,Fee,Slippage,Net,RealPnL,OrderID,Mode,Strategy,Score,ATR%,RR,Set,Notes";

function initFiles() {
  if (!existsSync(CSV_FILE))       writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  if (!existsSync(LOG_FILE))       writeFileSync(LOG_FILE, JSON.stringify({ trades:[] }, null, 2));
  if (!existsSync(POSITIONS_FILE)) writeFileSync(POSITIONS_FILE, "[]");
  if (!existsSync(BALANCE_FILE))   writeFileSync(BALANCE_FILE, JSON.stringify({ history:[], lastBalance:0, initialBalance:0 }, null, 2));
  if (!existsSync(STATE_FILE))     writeFileSync(STATE_FILE, JSON.stringify({ wins:{}, losses:{}, totalPnL:{}, totalFees:0, equityCurve:[] }, null, 2));
  if (!existsSync(SIG_CACHE_FILE)) writeFileSync(SIG_CACHE_FILE, "{}");
}

function loadLog()        { return existsSync(LOG_FILE)       ? JSON.parse(readFileSync(LOG_FILE,"utf8"))       : { trades:[] }; }
function saveLog(l)       { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function loadPositions()  { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE,"utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }
function loadState()      { return existsSync(STATE_FILE)     ? JSON.parse(readFileSync(STATE_FILE,"utf8"))     : { wins:{}, losses:{}, totalPnL:{}, totalFees:0, equityCurve:[] }; }
function saveState(s)     { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function loadSigCache()   { return existsSync(SIG_CACHE_FILE) ? JSON.parse(readFileSync(SIG_CACHE_FILE,"utf8")) : {}; }
function saveSigCache(c)  { writeFileSync(SIG_CACHE_FILE, JSON.stringify(c, null, 2)); }

function loadBalanceHistory() {
  return existsSync(BALANCE_FILE)
    ? JSON.parse(readFileSync(BALANCE_FILE,"utf8"))
    : { history:[], lastBalance:0, initialBalance:0 };
}
function saveBalance(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) bh.initialBalance = balance;
  bh.history.push({ timestamp: new Date().toISOString(), balance });
  if (bh.history.length > 200) bh.history = bh.history.slice(-200);
  bh.lastBalance = balance;
  writeFileSync(BALANCE_FILE, JSON.stringify(bh, null, 2));
}

function countTodaysTrades(log, symbol, strategy) {
  const today = new Date().toISOString().slice(0,10);
  return log.trades.filter(t =>
    t.timestamp?.startsWith(today) && t.orderPlaced &&
    t.symbol === symbol && t.strategy === strategy
  ).length;
}

function fmtPrice(p) {
  if (!p) return "0";
  if (p < 0.0001) return p.toFixed(10);
  if (p < 0.01)   return p.toFixed(8);
  if (p < 1)      return p.toFixed(6);
  return p.toFixed(4);
}

function writeCsvRow(e) {
  const d   = new Date(e.timestamp);
  const qty = e.tradeSize && e.price ? (e.tradeSize/e.price).toFixed(6) : "";
  const fee = e.tradeSize ? (e.tradeSize * CONFIG.feeRate).toFixed(4) : "";
  const slp = e.tradeSize ? (e.tradeSize * CONFIG.slippagePct).toFixed(4) : "";
  const net = e.tradeSize ? (e.tradeSize - parseFloat(fee) - parseFloat(slp)).toFixed(2) : "";
  const mode = !e.allPass ? "BLOCKED" : e.paperTrading ? "PAPER" : IS_LIVE ? "LIVE" : "DEMO";
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0,10), d.toISOString().slice(11,19),
    "Binance", e.symbol, e.side||"", qty,
    e.price ? fmtPrice(e.price) : "",
    e.tradeSize ? e.tradeSize.toFixed(2) : "",
    fee, slp, net,
    e.realPnL !== undefined ? e.realPnL.toFixed(4) : "",
    e.orderId||"BLOCKED", mode,
    e.strategy||"", e.score||0,
    e.atrPct ? e.atrPct.toFixed(3) : "",
    e.rr ? e.rr.toFixed(2) : "",
    e.triggerSet||"", `"${e.notes||""}"`
  ].join(",") + "\n");
}

function isDuplicateSignal(symbol, strategy, signal) {
  const cache = loadSigCache();
  const entry = cache[`${symbol}_${strategy}`];
  if (!entry) return false;
  return entry.signal === signal && (Date.now() - entry.ts) / 1000 < 3600;
}
function cacheSignal(symbol, strategy, signal) {
  const cache = loadSigCache();
  cache[`${symbol}_${strategy}`] = { signal, ts: Date.now() };
  saveSigCache(cache);
}

function checkDrawdown(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) return { ok:true, drawdownPct:0 };
  const pct = ((balance - bh.initialBalance) / bh.initialBalance) * 100;
  return { ok: pct > -CONFIG.maxDrawdown, drawdownPct: pct, initialBalance: bh.initialBalance };
}

function calcRealPnL(pos, exitPrice) {
  const qty      = pos.sizeUSD / pos.entryPrice;
  const exitTot  = qty * exitPrice;
  const fees     = (pos.sizeUSD + exitTot) * CONFIG.feeRate;
  const slippage = (pos.sizeUSD + exitTot) * CONFIG.slippagePct;
  const gross    = exitTot - pos.sizeUSD;
  return { gross, fees, slippage, net: gross - fees - slippage };
}

function updateStats(strategy, pnl, state) {
  state.wins[strategy]     = (state.wins[strategy]     || 0) + (pnl.net > 0 ? 1 : 0);
  state.losses[strategy]   = (state.losses[strategy]   || 0) + (pnl.net <= 0 ? 1 : 0);
  state.totalPnL[strategy] = (state.totalPnL[strategy] || 0) + pnl.net;
  state.totalFees          = (state.totalFees           || 0) + pnl.fees;
  state.equityCurve        = state.equityCurve || [];
  state.equityCurve.push({ timestamp: new Date().toISOString(), pnl: pnl.net, strategy });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}

function getOptimizedAllocation(state) {
  const bases = { S1:CONFIG.s1Pct, S2:CONFIG.s2Pct, macd:15, enhanced_macd:20, bollinger:10, volatility:8 };
  const alloc = {};
  for (const [s, base] of Object.entries(bases)) {
    const w = state.wins?.[s] || 0, l = state.losses?.[s] || 0, t = w + l;
    const wr = t >= 5 ? w / t : null;
    let pct = base;
    if (wr !== null) {
      if (wr > 0.65) pct = Math.min(pct * 1.2, 40);
      if (wr < 0.40) pct = Math.max(pct * 0.7, 5);
    }
    alloc[s] = { pct, wr };
  }
  return alloc;
}

function getEquityScaler(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) return 1.0;
  return Math.max(0.5, Math.min(1.2, balance / bh.initialBalance));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1] || 0;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g/period) / (l/period));
}

function calcStochRSI(closes) {
  if (closes.length < 28) return { k:50, d:50, oversold:false, overbought:false };
  const rv = [];
  for (let i = 14; i <= closes.length; i++) rv.push(calcRSI(closes.slice(0,i), 14));
  const recent = rv.slice(-14);
  const minR   = Math.min(...recent), maxR = Math.max(...recent);
  const rawK   = maxR === minR ? 50 : ((rv[rv.length-1] - minR) / (maxR - minR)) * 100;
  const prev1  = rv.length > 1 ? ((rv[rv.length-2] - minR) / (maxR - minR || 1)) * 100 : rawK;
  const prev2  = rv.length > 2 ? ((rv[rv.length-3] - minR) / (maxR - minR || 1)) * 100 : rawK;
  return { k: rawK, d: (rawK + prev1 + prev2) / 3, oversold: rawK < 20, overbought: rawK > 80 };
}

function calcMACD(closes, fast=12, slow=26, signal=9) {
  if (closes.length < slow) return { macdLine:0, signalLine:0, histogram:0 };
  const mv = [];
  for (let i = slow; i <= closes.length; i++) {
    const sl = closes.slice(0,i);
    mv.push(calcEMA(sl, fast) - calcEMA(sl, slow));
  }
  const macdLine   = mv[mv.length-1];
  const signalLine = calcEMA(mv, signal);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

function calcBB(closes, period=20, stdDev=2) {
  if (closes.length < period) return { upper:0, middle:0, lower:0, bandwidth:0, percentB:0 };
  const slice    = closes.slice(-period);
  const sma      = slice.reduce((a,b) => a+b, 0) / period;
  const variance = slice.reduce((s,c) => s + Math.pow(c-sma,2), 0) / period;
  const std      = Math.sqrt(variance);
  const upper    = sma + stdDev*std, lower = sma - stdDev*std;
  const price    = closes[closes.length-1];
  return { upper, middle:sma, lower, bandwidth:(upper-lower)/sma, percentB:(price-lower)/(upper-lower) };
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const sess     = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return candles[candles.length-1].close;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol  = sess.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv/vol : candles[candles.length-1].close;
}

function calcCMF(candles, period=20) {
  if (candles.length < period) return 0;
  const recent = candles.slice(-period);
  const mfv    = recent.map(c => {
    const hl = c.high - c.low;
    return hl === 0 ? 0 : ((c.close-c.low) - (c.high-c.close)) / hl * c.volume;
  });
  const sumMFV = mfv.reduce((a,b) => a+b, 0);
  const sumVol = recent.reduce((s,c) => s+c.volume, 0);
  return sumVol ? sumMFV / sumVol : 0;
}

function calcATR(candles, period=14) {
  if (candles.length < period+1) return 0;
  const trs = candles.slice(-period-1).map((c,i,arr) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high-c.low, Math.abs(c.high-arr[i-1].close), Math.abs(c.low-arr[i-1].close));
  });
  return trs.slice(1).reduce((a,b) => a+b, 0) / period;
}

function calcRSIDivergence(closes, period=14, lookback=5) {
  if (closes.length < period + lookback + 2) return { bullish:false, bearish:false };
  const rsiNow  = calcRSI(closes, period);
  const rsiPrev = calcRSI(closes.slice(0,-lookback), period);
  const pNow    = closes[closes.length-1];
  const pPrev   = closes[closes.length-1-lookback];
  return { bullish: pNow < pPrev && rsiNow > rsiPrev, bearish: pNow > pPrev && rsiNow < rsiPrev };
}

function calcTDSequential(closes) {
  if (closes.length < 10) return { count:0, setup:null, upCount:0, downCount:0 };
  let up = 0, dn = 0;
  for (let i = closes.length-1; i >= 4; i--) {
    if      (closes[i] > closes[i-4]) { if (dn===0) up++; else break; }
    else if (closes[i] < closes[i-4]) { if (up===0) dn++; else break; }
    else break;
  }
  return { count:Math.max(up,dn), setup: up>=9?"SELL_9":dn>=9?"BUY_9":null, upCount:up, downCount:dn };
}

function calcFibLevels(closes, lookback=50) {
  const recent = closes.slice(-Math.min(lookback, closes.length));
  const high   = Math.max(...recent), low = Math.min(...recent);
  const range  = high - low || 1;
  const price  = closes[closes.length-1];
  const f618   = high - range*0.618, f50 = high - range*0.5;
  return {
    high, low, fib618:f618, fib50:f50,
    nearFib618: Math.abs(price-f618)/f618 < 0.015,
    nearFib50:  Math.abs(price-f50)/f50   < 0.015,
  };
}

// ─── AI Score Engine ──────────────────────────────────────────────────────────
function calcAIScore(d, ob, m5, direction) {
  let score = 0;
  const buy = direction === "BUY";

  if (buy)  { if (d.rsi14 < 35) score += 20; else if (d.rsi14 < 50) score += 10; }
  else      { if (d.rsi14 > 65) score += 20; else if (d.rsi14 > 50) score += 10; }
  if (buy)  { if (d.cmf > 0.05) score += 20; else if (d.cmf > 0) score += 10; }
  else      { if (d.cmf < -0.05) score += 20; else if (d.cmf < 0) score += 10; }
  if (buy  && d.rsiDiv?.bullish) score += 15;
  if (!buy && d.rsiDiv?.bearish) score += 15;
  if (buy  && d.tdSeq?.setup === "BUY_9")  score += 15;
  if (!buy && d.tdSeq?.setup === "SELL_9") score += 15;
  if (d.volConfirmed) score += 10;
  if (ob) {
    if (buy  && ob.bullish)             score += 15;
    else if (buy  && ob.imbalance > 1)  score += 7;
    if (!buy && ob.bearish)             score += 15;
    else if (!buy && ob.imbalance < 1)  score += 7;
    if (ob.spread > 0.1) score -= 5;
  }
  if (m5) {
    if (buy  && m5.bullish)  score += 10;
    if (!buy && m5.bearish)  score += 10;
    if (m5.volSpike) score += 5;
  }
  if (buy && d.fib?.nearFib618) score += 5;
  if (d.atrPct > 5.0) score -= 10;
  else if (d.atrPct > 4.0) score -= 5;

  return Math.max(0, Math.min(100, score));
}

// ─── Full Asset Analysis ──────────────────────────────────────────────────────
async function analyzeAsset(symbol) {
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length-1];

  const ema5=calcEMA(closes,5); const ema8=calcEMA(closes,8); const ema13=calcEMA(closes,13);
  const ema21=calcEMA(closes,21); const ema50=calcEMA(closes,50); const ema200=calcEMA(closes,200);
  const rsi3=calcRSI(closes,3); const rsi14=calcRSI(closes,14);
  const stochRSI=calcStochRSI(closes); const macdData=calcMACD(closes);
  const bb=calcBB(closes); const vwap=calcVWAP(candles);
  const cmf=calcCMF(candles); const rsiDiv=calcRSIDivergence(closes);
  const tdSeq=calcTDSequential(closes); const fib=calcFibLevels(closes);
  const atr=calcATR(candles); const atrPct=price>0?(atr/price)*100:0;

  const vols       = candles.map(c => c.volume);
  const avgVol20   = vols.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const currentVol = vols[vols.length-1];
  const volConfirmed = currentVol > avgVol20 * 1.1;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const body = Math.abs(last.close - last.open);
  const wick = (last.high - last.low) || 0.0001;

  return {
    symbol, price, candles, closes,
    ema5, ema8, ema13, ema21, ema50, ema200,
    rsi3, rsi14, stochRSI, macdData, bb, vwap, cmf,
    rsiDiv, tdSeq, fib, atr, atrPct, volConfirmed,
    strongGreen: last.close > last.open && body/wick > 0.6,
    strongRed:   last.close < last.open && body/wick > 0.6,
    momentum:    last.close - prev.close,
  };
}

// ─── Strategy S1 (High Confidence) ───────────────────────────────────────────
function strategyS1(d, ob, m5) {
  const { price, ema5, ema8, ema13, ema21, ema50, ema200,
          rsi3, rsi14, stochRSI, macdData, bb, vwap, cmf,
          rsiDiv, tdSeq, fib, volConfirmed, strongGreen, strongRed, momentum } = d;

  const ribbonBull    = ema5>ema8 && ema8>ema13 && ema13>ema21 && ema21>ema50;
  const ribbonBear    = ema5<ema8 && ema8<ema13 && ema13<ema21 && ema21<ema50;
  const goldenZone    = price>ema50 && price>ema200;
  const nearEMA200    = price>ema200 && price<=ema200*1.02;
  const aboveVWAP     = price > vwap;
  const belowVWAP     = price < vwap;
  const macdBull      = macdData.macdLine > macdData.signalLine;
  const macdBear      = macdData.macdLine < macdData.signalLine;
  const macdCrossUp   = macdData.histogram > 0;
  const macdCrossDown = macdData.histogram < 0;
  const nearBBLower   = price <= bb.lower * 1.005;
  const nearBBUpper   = price >= bb.upper * 0.995;
  const cmfBull       = cmf > 0.05, cmfBear = cmf < -0.05;
  const posMom        = momentum > 0, negMom = momentum < 0;
  const stochOS       = stochRSI.oversold, stochOB = stochRSI.overbought;

  const setA     = ribbonBull && goldenZone && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setB     = ema8>ema21 && ema21>ema50 && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  const setC     = nearBBLower && rsi3<20 && (stochOS||rsi14<35) && ema8>ema21 && posMom;
  const setD     = nearEMA200 && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setE_buy = fib.nearFib618 && ribbonBull && goldenZone && rsi14<50 && (cmfBull||macdBull) && posMom;
  const setF_buy = rsiDiv.bullish && cmfBull && macdBull && ema8>ema21 && volConfirmed;
  const setG     = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed && cmfBear;
  const setH     = rsi3>80 && nearBBUpper && (stochOB||rsi14>65) && macdCrossDown && negMom;
  const setI     = (tdSeq.setup==="SELL_9"||rsiDiv.bearish) && cmfBear && macdBear && price<ema21;
  const setJ     = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;

  const buySignal  = setA||setB||setC||setD||setE_buy||setF_buy;
  const sellSignal = setG||setH||setI||setJ;

  let signal = null;
  if (buySignal  && !sellSignal) signal = "BUY";
  if (sellSignal && !buySignal)  signal = "SELL";

  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy:"S1",
    details:{ setA,setB,setC,setD,setE_buy,setF_buy,setG,setH,setI,setJ,
              ribbonBull,ribbonBear,goldenZone,macdBull,macdBear } };
}

// ─── Strategy S2 (Opportunistic) ─────────────────────────────────────────────
function strategyS2(d, ob, m5) {
  const { price, ema8, ema21, ema50, rsi14, macdData, bb, vwap, cmf,
          rsiDiv, tdSeq, fib, volConfirmed, momentum } = d;

  const emaStackBull = ema8>ema21 && ema21>ema50;
  const emaStackBear = ema8<ema21 && ema21<ema50;
  const aboveVWAP    = price > vwap, belowVWAP = price < vwap;
  const macdBull     = macdData.macdLine > macdData.signalLine;
  const macdBear     = macdData.macdLine < macdData.signalLine;
  const nearBBLower  = price <= bb.lower * 1.02;
  const nearBBUpper  = price >= bb.upper * 0.98;
  const cmfPos       = cmf > 0, cmfNeg = cmf < 0;
  const posMom       = momentum > 0, negMom = momentum < 0;

  const setA2 = emaStackBull && rsi14<55 && (macdBull||cmfPos) && aboveVWAP;
  const setB2 = (fib.nearFib618||fib.nearFib50) && emaStackBull && rsi14<60 && posMom;
  const setC2 = nearBBLower && rsi14<45 && posMom && (emaStackBull||price>ema50);
  const setD2 = rsiDiv.bullish && (emaStackBull||price>ema50) && posMom;
  const setE2 = tdSeq.setup==="BUY_9" && (macdBull||cmfPos);
  const setF2 = emaStackBear && (macdBear||cmfNeg) && belowVWAP;
  const setG2 = nearBBUpper && rsi14>60 && negMom;
  const setH2 = (rsiDiv.bearish||tdSeq.setup==="SELL_9") && (macdBear||cmfNeg);

  const buySignal  = setA2||setB2||setC2||setD2||setE2;
  const sellSignal = setF2||setG2||setH2;

  let signal = null;
  if (buySignal  && !sellSignal) signal = "BUY";
  if (sellSignal && !buySignal)  signal = "SELL";

  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy:"S2",
    details:{ setA2,setB2,setC2,setD2,setE2,setF2,setG2,setH2 } };
}

// ─── Strategy MACD ───────────────────────────────────────────────────────────
function strategyMACD(d, ob, m5) {
  const { price, ema50, macdData, volConfirmed } = d;
  const buy  = macdData.macdLine > macdData.signalLine && price > ema50 && volConfirmed;
  const sell = macdData.macdLine < macdData.signalLine && price < ema50;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  return { signal, score: signal ? calcAIScore(d, ob, m5, signal) : 0, strategy:"macd", details:{ buy, sell } };
}

// ─── Strategy Enhanced MACD ───────────────────────────────────────────────────
function strategyEnhancedMACD(d, ob, m5) {
  const { price, ema50, ema200, rsi14, macdData, bb, cmf, volConfirmed } = d;
  const trendBull = price>ema50 && ema50>ema200;
  const trendBear = price<ema50 && ema50<ema200;
  const macdBull  = macdData.macdLine>macdData.signalLine && macdData.histogram>0;
  const macdBear  = macdData.macdLine<macdData.signalLine && macdData.histogram<0;
  // Both buy AND sell scored via calcAIScore
  const buy  = trendBull && macdBull && rsi14<60 && price>bb.lower && price<bb.upper && volConfirmed && cmf>0.05;
  const sell = trendBear && macdBear && rsi14>40 && price>bb.lower && price<bb.upper && volConfirmed && cmf<-0.05;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  return { signal, score: signal ? calcAIScore(d, ob, m5, signal) : 0, strategy:"enhanced_macd", details:{ buy, sell } };
}

// ─── Strategy Bollinger ───────────────────────────────────────────────────────
function strategyBollinger(d, ob, m5) {
  const { price, bb, rsi14, stochRSI, volConfirmed } = d;
  const buy  = price<=bb.lower*1.02 && rsi14<35 && stochRSI.k<20 && volConfirmed;
  const sell = price>=bb.upper*0.98 && rsi14>65 && stochRSI.k>80 && volConfirmed;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  return { signal, score: signal ? calcAIScore(d, ob, m5, signal) : 0, strategy:"bollinger", details:{ buy, sell } };
}

// ─── Strategy Volatility Breakout ─────────────────────────────────────────────
function strategyVolatility(d, ob, m5) {
  const { price, candles, volConfirmed, momentum } = d;
  // Exclude current candle — compare price against prior 20 bars
  const prevCandles  = candles.slice(-21, -1);
  const highs        = prevCandles.map(c => c.high);
  const lows         = prevCandles.map(c => c.low);
  const highest      = Math.max(...highs);
  const lowest       = Math.min(...lows);
  const breakoutUp   = price > highest && momentum > 0 && volConfirmed;
  const breakoutDown = price < lowest  && momentum < 0 && volConfirmed;
  const signal       = breakoutUp ? "BUY" : breakoutDown ? "SELL" : null;
  return { signal, score: signal ? calcAIScore(d, ob, m5, signal) : 0, strategy:"volatility", details:{ breakoutUp, breakoutDown, highest, lowest } };
}

// ─── Execute Signal ───────────────────────────────────────────────────────────
async function executeSignal(symbol, signal, strategy, score, price, atr, balance, equityScaler, allocPct, logEntry) {
  // Duplicate position guard — BEFORE order
  const existing = loadPositions().find(p => p.symbol===symbol && p.strategy===strategy);
  if (existing) {
    console.log(`   ⚠️  [${strategy}] Open position already exists @ ${fmtPrice(existing.entryPrice)} — skipping`);
    return;
  }
  if (loadPositions().length >= CONFIG.maxPositions) {
    console.log(`   ⚠️  Max positions (${loadPositions().length}/${CONFIG.maxPositions}) — skipping`);
    return;
  }

  // ATR-based position sizing with allocation %
  const riskAmount = balance * (allocPct / 100) * equityScaler;
  const stopDist   = atr * 1.5;
  const priceRisk  = stopDist / price;
  const sizeByRisk = priceRisk > 0 ? riskAmount / priceRisk : 0;
  const size       = Math.min(sizeByRisk, balance * 0.4, CONFIG.maxTradeUSD);
  const stopPrice  = signal==="BUY" ? price*(1-priceRisk) : price*(1+priceRisk);
  const tpPrice    = signal==="BUY" ? price*(1+(stopDist*CONFIG.rrRatio/price)) : price*(1-(stopDist*CONFIG.rrRatio/price));

  Object.assign(logEntry, {
    tradeSize: size, signal, triggerSet: strategy, allPass: true,
    score, atrPct: (atr/price*100), rr: CONFIG.rrRatio,
  });

  if (CONFIG.paperTrading) {
    Object.assign(logEntry, { orderPlaced:true, orderId:`PAPER-${Date.now()}`, side:signal });
    logEntry.notes = `Paper ${signal} Sc:${score} ATR:${logEntry.atrPct.toFixed(2)}% via ${strategy}`;
    console.log(`   📋 PAPER ${signal} $${size.toFixed(2)} @ ${fmtPrice(price)} | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(stopPrice)} RR:${CONFIG.rrRatio}`);
  } else {
    try {
      const order = await placeMarketOrder(symbol, signal, size/price);
      Object.assign(logEntry, { orderPlaced:true, orderId:String(order.orderId), side:signal });
      logEntry.notes = `Live ${signal} ID:${order.orderId} Sc:${score} via ${strategy}`;
      console.log(`   ✅ LIVE ${signal} ID:${order.orderId} $${size.toFixed(2)} @ ${fmtPrice(price)}`);
    } catch (err) {
      console.log(`   ❌ Order failed: ${err.message}`);
      logEntry.notes = `Failed: ${err.message}`;
    }
  }

  if (logEntry.orderPlaced && signal === "BUY") {
    const positions = loadPositions();
    positions.push({ symbol, entryPrice:price, sizeUSD:size, strategy, timestamp:new Date().toISOString(), tpPrice, slPrice:stopPrice, rr:CONFIG.rrRatio });
    savePositions(positions);
    cacheSignal(symbol, strategy, signal);
  }
}

// ─── TP/SL + Trailing Stop (saves trailing update to disk) ───────────────────
async function checkExits(symbol, price, botState) {
  const all       = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others    = all.filter(p => p.symbol !== symbol);
  const remaining = [];
  let   changed   = false;

  for (const pos of positions) {
    const pnlPct  = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    let   slPrice = pos.slPrice || pos.entryPrice*(1 - CONFIG.stopLossPct/100);
    const tpPrice = pos.tpPrice || pos.entryPrice*(1 + CONFIG.takeProfitPct/100);

    // Trailing stop — update and save
    if (pnlPct >= CONFIG.trailingActivate) {
      const trailPrice = price * (1 - CONFIG.trailingStopPct/100);
      if (trailPrice > slPrice) {
        slPrice      = trailPrice;
        pos.slPrice  = slPrice;
        changed      = true;
      }
    }

    if (price >= tpPrice || price <= slPrice) {
      const reason = price >= tpPrice ? "TAKE_PROFIT" : "STOP_LOSS";
      const pnl    = calcRealPnL(pos, price);
      updateStats(pos.strategy, pnl, botState);
      console.log(`   ${reason==="TAKE_PROFIT"?"✅":"🛑"} [${pos.strategy}] ${symbol} ${reason} | P&L:${pnlPct.toFixed(2)}% Net:$${pnl.net.toFixed(3)}`);
      if (!CONFIG.paperTrading) {
        await placeMarketOrder(symbol, "SELL", pos.sizeUSD/price);
      } else {
        console.log(`   📋 PAPER EXIT | Net:$${pnl.net.toFixed(3)}`);
      }
      writeCsvRow({ timestamp:new Date().toISOString(), symbol, price, tradeSize:pos.sizeUSD, allPass:true,
                   paperTrading:CONFIG.paperTrading, orderPlaced:true, orderId:`EXIT-${Date.now()}`,
                   side:"SELL", notes:reason, strategy:pos.strategy, realPnL:pnl.net });
    } else {
      const icon = pnlPct >= 0 ? "📈" : "📉";
      console.log(`   ⏳ [${pos.strategy}] ${symbol} ${icon}${pnlPct.toFixed(2)}% | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(slPrice)}${pnlPct>=CONFIG.trailingActivate?" 🔄Trail":""}`);
      remaining.push(pos);
    }
  }

  // Always save if trailing changed OR positions were closed
  if (changed || remaining.length !== positions.length) {
    savePositions([...others, ...remaining]);
  }
}

// ─── Morning Brief ────────────────────────────────────────────────────────────
async function morningBrief() {
  const botState = loadState();
  const alloc    = getOptimizedAllocation(botState);
  const balance  = await fetchAccountBalance();
  const dd       = checkDrawdown(balance);
  const openPos  = loadPositions();

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║     TradeBotIQ v4.6x — MORNING BRIEF                     ║");
  console.log(`║     ${new Date().toUTCString().slice(0,53).padEnd(53)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  console.log(`  Balance: $${balance.toFixed(2)} | DD:${dd.drawdownPct.toFixed(1)}% | ${dd.ok?"🟢 OK":"🛑 PAUSED"}`);
  console.log(`  Positions: ${openPos.length}/${CONFIG.maxPositions} | Mode: ${CONN.fastMode?"⚡ FAST":"🐢 CONSERVATIVE"}`);
  console.log(`  recWind range: ${CONFIG.recWindMin}–${CONFIG.recWindMax}s\n`);

  for (const [s, a] of Object.entries(alloc)) {
    const pnlStr = `PnL:$${(botState.totalPnL?.[s]||0).toFixed(2)}`;
    const wrStr  = a.wr !== null ? `WR:${(a.wr*100).toFixed(0)}%` : "WR:new";
    console.log(`  ${s.padEnd(16)} ${wrStr.padEnd(8)} Alloc:${a.pct.toFixed(0)}% ${pnlStr}`);
  }
  console.log("");

  for (const symbol of CONFIG.assets) {
    await new Promise(r => setTimeout(r, assetDelay()));
    const d  = await analyzeAsset(symbol);
    const ob = await fetchOrderBook(symbol);
    await new Promise(r => setTimeout(r, requestDelay()));
    const m5 = await get5mConfirmation(symbol);
    const s1 = strategyS1(d, ob, m5);
    const s2 = strategyS2(d, ob, m5);
    const ribbonStr = d.ema5>d.ema8&&d.ema8>d.ema21 ? "📈 BULL" : d.ema5<d.ema8&&d.ema8<d.ema21 ? "📉 BEAR" : "↔️  FLAT";
    console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | ${ribbonStr} | CMF:${d.cmf.toFixed(3)} | ATR:${d.atrPct.toFixed(2)}%`);
    console.log(`    S1:${s1.signal?`${s1.signal}(Sc:${s1.score})`:"⚪"} | S2:${s2.signal?`${s2.signal}(Sc:${s2.score})`:"⚪"}`);
  }

  writeFileSync(BRIEF_FILE, JSON.stringify({
    timestamp: new Date().toISOString(),
    balance, drawdownPct: dd.drawdownPct,
    connMode: CONN.fastMode ? "fast" : "conservative",
  }, null, 2));
  console.log(`\n  Brief saved → ${BRIEF_FILE}\n`);
}

// ─── PineScript Export ────────────────────────────────────────────────────────
function exportPineScript() {
  const pine = `//@version=5
strategy("TradeBotIQ v4.6x — Extended", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1)

ema5=ta.ema(close,5); ema8=ta.ema(close,8); ema13=ta.ema(close,13)
ema21=ta.ema(close,21); ema50=ta.ema(close,50); ema200=ta.ema(close,200)
plot(ema5,color=color.lime,linewidth=1); plot(ema8,color=color.green,linewidth=1)
plot(ema13,color=color.teal,linewidth=1); plot(ema21,color=color.blue,linewidth=2)
plot(ema50,color=color.orange,linewidth=2); plot(ema200,color=color.red,linewidth=3)

rsi3=ta.rsi(close,3); rsi14=ta.rsi(close,14)
[ml,sl,hist]=ta.macd(close,12,26,9)
[bbU,bbM,bbL]=ta.bb(close,20,2)
vwapVal=ta.vwap(hlc3)
mfv=((close-low)-(high-close))/(high-low==0?1:high-low)*volume
cmf=ta.sma(mfv,20)/ta.sma(volume,20)
volOk=volume>ta.sma(volume,20)*1.1
ph=ta.highest(high,50); pl=ta.lowest(low,50)
fib618=ph-(ph-pl)*0.618; fib50=ph-(ph-pl)*0.5
plot(fib618,color=color.new(color.yellow,50),linewidth=1,title="Fib 61.8%")
plot(fib50, color=color.new(color.yellow,70),linewidth=1,title="Fib 50%")
rsiPrev=rsi14[5]
bullDiv=close<close[5] and rsi14>rsiPrev
bearDiv=close>close[5] and rsi14<rsiPrev
ribbonBull=ema5>ema8 and ema8>ema13 and ema13>ema21 and ema21>ema50
ribbonBear=ema5<ema8 and ema8<ema13 and ema13<ema21 and ema21<ema50
goldenZone=close>ema50 and close>ema200
body=math.abs(close-open); wick=math.max(high-low,0.0001)
strongGreen=close>open and body/wick>0.6; strongRed=close<open and body/wick>0.6

s1A=ribbonBull and goldenZone and rsi14<35 and ml>sl and volOk and cmf>0.05
s1B=ema8>ema21 and ema21>ema50 and strongGreen and hist>0 and close>vwapVal and volOk
s1C=close<=bbL*1.005 and rsi3<20 and rsi14<35 and ema8>ema21 and close>close[1]
s1D=close>ema200 and close<=ema200*1.02 and rsi14<35 and ml>sl and volOk and cmf>0.05
s1E=math.abs(close-fib618)/fib618<0.015 and ribbonBull and goldenZone and rsi14<50 and cmf>0
s1F=bullDiv and cmf>0.05 and ml>sl and ema8>ema21 and volOk
s1G=ribbonBear and ml<sl and close<vwapVal and close<ema21 and volOk and cmf<-0.05
s1H=rsi3>80 and close>=bbU*0.995 and rsi14>65 and hist<0 and close<close[1]
s1J=strongRed and close<ema21 and close<ema50 and ml<sl and close<vwapVal

s2A=ema8>ema21 and ema21>ema50 and rsi14<55 and (ml>sl or cmf>0) and close>vwapVal
s2B=(math.abs(close-fib618)/fib618<0.015 or math.abs(close-fib50)/fib50<0.015) and ema8>ema21 and rsi14<60 and close>close[1]
s2D=bullDiv and (ema8>ema21 or close>ema50) and close>close[1]

s1Buy=(s1A or s1B or s1C or s1D or s1E or s1F) and not(s1G or s1H or s1J)
s1Sell=(s1G or s1H or s1J) and not(s1A or s1B or s1C or s1D or s1E or s1F)
s2Buy=(s2A or s2B or s2D) and not s1Sell

if s1Buy
    strategy.entry("S1",strategy.long,qty_value=30)
    strategy.exit("S1x","S1",profit=close*0.035/syminfo.mintick,loss=close*0.01/syminfo.mintick)
if s2Buy
    strategy.entry("S2",strategy.long,qty_value=5)
    strategy.exit("S2x","S2",profit=close*0.035/syminfo.mintick,loss=close*0.01/syminfo.mintick)
if s1Sell
    strategy.close_all(comment="Sell")

plotshape(s1Buy,location=location.belowbar,color=color.green,style=shape.labelup,text="S1")
plotshape(s2Buy,location=location.belowbar,color=color.lime,style=shape.triangleup,text="S2")
plotshape(s1Sell,location=location.abovebar,color=color.red,style=shape.labeldown,text="SELL")
bgcolor(goldenZone?color.new(color.green,95):color.new(color.red,95))
alertcondition(s1Buy,"S1 BUY","TradeBotIQ S1 BUY: {{ticker}} @ {{close}}")
alertcondition(s2Buy,"S2 BUY","TradeBotIQ S2 BUY: {{ticker}} @ {{close}}")
alertcondition(s1Sell,"SELL","TradeBotIQ SELL: {{ticker}} @ {{close}}")
`;
  writeFileSync("TradeBotIQ.pine", pine);
  console.log("✅ PineScript v4.6x saved → TradeBotIQ.pine");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();
  cleanCache();

  if (process.argv.includes("--brief")) { await morningBrief(); return; }
  if (process.argv.includes("--pine"))  { exportPineScript();   return; }

  // ── Auth verification with recWind retry ──────────────────────────────────
  let authOk = false;
  let authMaxAttempts = 5;
  for (let a = 0; a < authMaxAttempts && !authOk; a++) {
    authOk = await verifyAuth();
  }
  if (!authOk) {
    console.log("🛑 Could not authenticate after attempts — aborting run");
    return;
  }

  const botState     = loadState();
  const alloc        = getOptimizedAllocation(botState);
  const balance      = await fetchAccountBalance();
  const equityScaler = getEquityScaler(balance);
  const dd           = checkDrawdown(balance);
  const bh           = loadBalanceHistory();
  const prevBal      = bh.history.length > 1 ? bh.history[bh.history.length-2]?.balance : balance;
  const openPos      = loadPositions();

  if (!dd.ok) {
    console.log(`\n🛑 MAX DRAWDOWN BREACHED — Trading paused`);
    console.log(`   Balance:$${balance.toFixed(2)} Initial:$${dd.initialBalance?.toFixed(2)} DD:${dd.drawdownPct.toFixed(1)}% (max -${CONFIG.maxDrawdown}%)\n`);
    return;
  }

  const activeList = CONFIG.activeStrategies.includes("all")
    ? ["S1","S2","macd","enhanced_macd","bollinger","volatility"]
    : CONFIG.activeStrategies;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v4.6x — Extended Edition");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:       ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | ${IS_LIVE?"🔴 LIVE Binance":"🧪 DEMO"}`);
  console.log(`  Signing:    🔐 Ed25519 | Auth: ✅ ${CONN.lastAuthTime}`);
  console.log(`  Speed:      ${CONN.fastMode?"⚡ FAST (800–1200ms)":"🐢 Conservative (1200–1700ms)"}`);
  console.log(`  recWind:    ${CONFIG.recWindMin}–${CONFIG.recWindMax}s | Last: ${CONN.lastRecWind?(CONN.lastRecWind/1000).toFixed(1)+"s":"N/A"}`);
  console.log(`  Balance:    $${balance.toFixed(2)} ${(balance-prevBal)>=0?`📈+$${(balance-prevBal).toFixed(2)}`:`📉-$${Math.abs(balance-prevBal).toFixed(2)}`}`);
  console.log(`  Drawdown:   ${dd.drawdownPct.toFixed(1)}% (max -${CONFIG.maxDrawdown}%) 🟢`);
  console.log(`  Equity Scl: ${equityScaler.toFixed(2)}x`);
  console.log(`  Positions:  ${openPos.length}/${CONFIG.maxPositions} open`);
  console.log(`  Strategies: ${activeList.join(", ")}`);
  console.log(`  Assets:     ${CONFIG.assets.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.paperTrading) saveBalance(balance);

  const log          = loadLog();
  const strategyFns  = {
    S1: strategyS1, S2: strategyS2,
    macd: strategyMACD, enhanced_macd: strategyEnhancedMACD,
    bollinger: strategyBollinger, volatility: strategyVolatility,
  };

  for (const symbol of CONFIG.assets) {
    // Adaptive inter-asset delay
    await new Promise(r => setTimeout(r, assetDelay()));

    let d, ob, m5;
    try {
      d  = await analyzeAsset(symbol);
      await new Promise(r => setTimeout(r, requestDelay()));
      ob = await fetchOrderBook(symbol);
      await new Promise(r => setTimeout(r, requestDelay()));
      m5 = await get5mConfirmation(symbol);
    } catch (err) {
      console.log(`\n── ${symbol} ❌ Data fetch failed: ${err.message}`);
      continue;
    }

    const ribbonStr = d.ema5>d.ema8&&d.ema8>d.ema13&&d.ema13>d.ema21&&d.ema21>d.ema50
      ? "📈 BULL" : d.ema5<d.ema8&&d.ema8<d.ema13&&d.ema13<d.ema21&&d.ema21<d.ema50
      ? "📉 BEAR" : "↔️  FLAT";
    const zoneStr   = d.price>d.ema50&&d.price>d.ema200 ? "🟢" : "🔴";
    const obStr     = ob ? `Imb:${ob.imbalance.toFixed(2)}${ob.bullish?"🟢":ob.bearish?"🔴":""}` : "N/A";
    const m5Str     = m5 ? (m5.bullish?"📈":m5.bearish?"📉":"↔️") : "N/A";

    console.log(`\n── ${symbol} ${fmtPrice(d.price)} ─────────────────────────────────────`);
    console.log(`   ${ribbonStr} | Zone:${zoneStr} | CMF:${d.cmf.toFixed(3)} | TD:${d.tdSeq.count}${d.tdSeq.upCount>0?"↑":"↓"} | ATR:${d.atrPct.toFixed(2)}%`);
    console.log(`   RSI14:${d.rsi14.toFixed(1)} RSI3:${d.rsi3.toFixed(1)} MACD:${d.macdData.macdLine>d.macdData.signalLine?"🟢":"🔴"} Vol:${d.volConfirmed?"✅":"⚠️"}`);
    console.log(`   OB:${obStr} | 5m:${m5Str} RSI5m:${m5?.rsi5m?.toFixed(1)||"N/A"} | Fib618:${fmtPrice(d.fib.fib618)} Near:${d.fib.nearFib618?"✅":"🚫"}`);
    console.log(`   Div: Bull:${d.rsiDiv.bullish?"✅":"🚫"} Bear:${d.rsiDiv.bearish?"✅":"🚫"} | StochK:${d.stochRSI.k.toFixed(1)}`);

    await checkExits(symbol, d.price, botState);

    for (const stratName of activeList) {
      const fn = strategyFns[stratName];
      if (!fn) continue;

      const res = fn(d, ob, m5);
      if (!res.signal) { console.log(`   ⚪ ${stratName}: No signal`); continue; }

      const minScore = stratName==="S1" ? CONFIG.minScoreS1
                     : stratName==="S2" ? CONFIG.minScoreS2
                     : CONFIG.minScoreGeneral;

      if (res.score < minScore) {
        console.log(`   ⚠️  ${stratName} ${res.signal} score ${res.score}<${minScore} — skipped`);
        continue;
      }
      if (isDuplicateSignal(symbol, stratName, res.signal)) {
        console.log(`   ⏭️  ${stratName} ${res.signal} — duplicate within 1H, skipped`);
        continue;
      }
      if (countTodaysTrades(log, symbol, stratName) >= CONFIG.maxTradesPerDay) {
        console.log(`   🚫 ${stratName} daily limit reached`);
        continue;
      }

      const allocPct = alloc[stratName]?.pct || CONFIG.s1Pct;
      console.log(`   🎯 ${stratName} ${res.signal} | Score:${res.score} | Alloc:${allocPct.toFixed(0)}%`);

      const logEntry = {
        timestamp: new Date().toISOString(), symbol, price: d.price,
        paperTrading: CONFIG.paperTrading, strategy: stratName,
      };
      await executeSignal(symbol, res.signal, stratName, res.score, d.price, d.atr, balance, equityScaler, allocPct, logEntry);
      log.trades.push(logEntry);
      writeCsvRow(logEntry);

      // Small gap between strategies on same symbol
      await new Promise(r => setTimeout(r, requestDelay()));
    }
  }

  saveLog(log);
  saveState(botState);

  const finalPos = loadPositions();
  console.log(`\n✅ Run complete | $${balance.toFixed(2)} | Pos:${finalPos.length}/${CONFIG.maxPositions} | DD:${dd.drawdownPct.toFixed(1)}%`);
  console.log(`   Speed: ${CONN.fastMode?"⚡ FAST":"🐢 Conservative"} | recWind last: ${CONN.lastRecWind?(CONN.lastRecWind/1000).toFixed(1)+"s":"N/A"}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err.stack || err.message); process.exit(1); }); 
