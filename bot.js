/**
 * TradeBotIQ v4.6e — Pure Custom REST (Ed25519) – Full Control, Fully Fixed
 * ============================================================================
 * Fixes from v4.6 audit:
 * - Public endpoints (klines, depth) use unsigned fetch.
 * - signRequest uses insertion order (Object.entries preserves order in ES6+).
 * - Trailing stop updates saved to positions.json.
 * - Volatility breakout excludes current candle from channel calculation.
 * - S2 volConfirmed destructuring fixed.
 * - AI scoring restored (combines OB, 5m, RSI, CMF, Div, TD, Fib, ATR).
 * - Order book and 5m confirmation re‑integrated into scoring.
 * - 3‑tier cache restored (klines 30s, OB 10s, account 60s, symbols 24h).
 * - --brief and --pine CLI flags restored.
 * - Trade size now uses optimizer allocation (risk % from alloc pct).
 * - Enhanced MACD sell signals now scored correctly.
 * - Minor naming consistency (macdData).
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
  activeStrategies: (process.env.ACTIVE_STRATEGIES || "all").toLowerCase().split(",").map(s=>s.trim()),
};

// ─── Ed25519 Signing & Custom REST ────────────────────────────────────────────
const privateKeyPem = process.env.BINANCE_PRIVATE_KEY;
const apiKey = IS_LIVE ? process.env.BINANCE_API_KEY : process.env.BINANCE_DEMO_API_KEY;
if (!privateKeyPem) throw new Error("BINANCE_PRIVATE_KEY required (Ed25519 PEM)");
if (!apiKey) throw new Error("BINANCE_API_KEY or BINANCE_DEMO_API_KEY required");

const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });

// Binance expects parameters in insertion order (Object.entries preserves ES6+ order)
function signRequest(params) {
  const timestamp = Date.now();
  const allParams = { ...params, timestamp };
  // Build query string in insertion order (do NOT sort)
  const qs = Object.entries(allParams).map(([k,v]) => `${k}=${v}`).join("&");
  const signature = cryptoSign(null, Buffer.from(qs), privateKey).toString("base64url");
  return { qs, signature };
}

async function binanceRequest(method, path, params = {}, signed = true, retries = 5) {
  let url;
  if (signed) {
    const { qs, signature } = signRequest(params);
    url = `${CONFIG.apiBase}${path}?${qs}&signature=${signature}`;
  } else {
    const qs = Object.entries(params).map(([k,v])=>`${k}=${v}`).join("&");
    url = `${CONFIG.apiBase}${path}?${qs}`;
  }
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: signed ? { "X-MBX-APIKEY": apiKey, "Content-Type": "application/json" } : {},
      });
      const data = await res.json();
      if (data.code && data.code < 0) throw new Error(`Binance ${data.code}: ${data.msg}`);
      return data;
    } catch (err) {
      lastErr = err;
      if (i === retries - 1) break;
      const delay = Math.min(1000 * Math.pow(2, i), 60000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── 3‑Tier Cache ────────────────────────────────────────────────────────────
const CACHE = new Map();
const CACHE_TTL = {
  klines:   30_000,
  orderbook:10_000,
  account:  60_000,
  ticker:   15_000,
  symbols:  86_400_000,
};

function cacheGet(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > entry.ttl) {
    entry.stale = true;
    return entry;
  }
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
  const key = `klines_${symbol}_${interval}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const map = { "1h":"1h","2h":"2h","4h":"4h","1d":"1d","5m":"5m" };
  const data = await binanceRequest("GET", "/api/v3/klines", {
    symbol, interval: map[interval]||"1h", limit
  }, false); // unsigned public endpoint
  const candles = data.map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
  cacheSet(key, candles, "klines");
  return candles;
}

async function fetchOrderBook(symbol, limit = 20) {
  const key = `ob_${symbol}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const data = await binanceRequest("GET", "/api/v3/depth", { symbol, limit }, false);
  const bidVol = data.bids.reduce((s,b) => s + parseFloat(b[1]), 0);
  const askVol = data.asks.reduce((s,a) => s + parseFloat(a[1]), 0);
  const imbalance = askVol > 0 ? bidVol / askVol : 1;
  const topBid = parseFloat(data.bids[0]?.[0] || 0);
  const topAsk = parseFloat(data.asks[0]?.[0] || 0);
  const spread = topAsk > 0 ? (topAsk - topBid) / topAsk * 100 : 0;
  const result = { bidVol, askVol, imbalance, spread, bullish: imbalance > 1.15, bearish: imbalance < 0.85 };
  cacheSet(key, result, "orderbook");
  return result;
}

async function get5mConfirmation(symbol) {
  const key = `5m_${symbol}`;
  const cached = cacheGet(key);
  if (cached && !cached.stale) return cached.data;

  const candles = await fetchCandles(symbol, "5m", 20);
  const closes = candles.map(c => c.close);
  const vols = candles.map(c => c.volume);
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const rsi5m = calcRSI(closes, 7);
  const avgVol = vols.slice(-10).reduce((a,b)=>a+b,0) / 10;
  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const body = Math.abs(last.close - last.open);
  const wick = (last.high - last.low) || 0.0001;
  const result = {
    bullish:      ema8 > ema21 && rsi5m < 65 && last.close > prev.close,
    bearish:      ema8 < ema21 && rsi5m > 35 && last.close < prev.close,
    volSpike:     vols[vols.length-1] > avgVol * 1.5,
    strongCandle: body/wick > 0.6,
    rsi5m,
  };
  cacheSet(key, result, "klines");
  return result;
}

async function placeMarketOrder(symbol, side, quantity) {
  const qty = formatQty(symbol, quantity);
  return binanceRequest("POST", "/api/v3/order", {
    symbol, side: side.toUpperCase(), type: "MARKET", quantity: qty.toFixed(PRECISION[symbol]?.qty || 4)
  }, true);
}

// ─── Precision ────────────────────────────────────────────────────────────────
const PRECISION = {
  BTCUSDT: { qty:5, price:2, minQty:0.00001 }, ETHUSDT: { qty:4, price:2, minQty:0.0001 },
  SOLUSDT: { qty:2, price:3, minQty:0.01 }, XRPUSDT: { qty:1, price:4, minQty:0.1 },
  LINKUSDT:{ qty:2, price:3, minQty:0.01 }, PEPEUSDT:{ qty:0, price:8, minQty:1 },
};
function formatQty(symbol, qty) {
  const p = PRECISION[symbol] || { qty:4, minQty:0.0001 };
  const rounded = parseFloat(qty.toFixed(p.qty));
  return Math.max(rounded, p.minQty);
}

// ─── Files (identical) ────────────────────────────────────────────────────────
const LOG_FILE = "safety-check-log.json", POSITIONS_FILE = "positions.json", CSV_FILE = "trades.csv";
const BRIEF_FILE = "morning-brief.json", BALANCE_FILE = "balance-history.json", STATE_FILE = "bot-state.json";
const SIG_CACHE_FILE = "signal-cache.json";
const CSV_HEADERS = "Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,USD,Fee,Slippage,Net,RealPnL,OrderID,Mode,Strategy,Score,ATR%,RR,Set,Notes";

function initFiles() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  if (!existsSync(LOG_FILE)) writeFileSync(LOG_FILE, JSON.stringify({ trades:[] }, null, 2));
  if (!existsSync(POSITIONS_FILE)) writeFileSync(POSITIONS_FILE, "[]");
  if (!existsSync(BALANCE_FILE)) writeFileSync(BALANCE_FILE, JSON.stringify({ history:[], lastBalance:0, initialBalance:0 }, null, 2));
  if (!existsSync(STATE_FILE)) writeFileSync(STATE_FILE, JSON.stringify({ wins:{}, losses:{}, totalPnL:{}, totalFees:0, equityCurve:[] }, null, 2));
  if (!existsSync(SIG_CACHE_FILE)) writeFileSync(SIG_CACHE_FILE, "{}");
}
function loadLog() { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE,"utf8")) : { trades:[] }; }
function saveLog(l) { writeFileSync(LOG_FILE, JSON.stringify(l,null,2)); }
function loadPositions() { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE,"utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p,null,2)); }
function loadState() { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE,"utf8")) : { wins:{},losses:{},totalPnL:{},totalFees:0,equityCurve:[] }; }
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); }
function loadSigCache() { return existsSync(SIG_CACHE_FILE) ? JSON.parse(readFileSync(SIG_CACHE_FILE,"utf8")) : {}; }
function saveSigCache(c) { writeFileSync(SIG_CACHE_FILE, JSON.stringify(c,null,2)); }
function loadBalanceHistory() { return existsSync(BALANCE_FILE) ? JSON.parse(readFileSync(BALANCE_FILE,"utf8")) : { history:[], lastBalance:0, initialBalance:0 }; }
function saveBalance(balance) {
  const bh = loadBalanceHistory();
  if (!bh.initialBalance) bh.initialBalance = balance;
  bh.history.push({ timestamp: new Date().toISOString(), balance });
  if (bh.history.length > 200) bh.history = bh.history.slice(-200);
  bh.lastBalance = balance;
  writeFileSync(BALANCE_FILE, JSON.stringify(bh,null,2));
}
function countTodaysTrades(log, symbol, strategy) {
  const today = new Date().toISOString().slice(0,10);
  return log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced && t.symbol===symbol && t.strategy===strategy).length;
}
function fmtPrice(p) {
  if (!p) return "0";
  if (p < 0.0001) return p.toFixed(10); if (p < 0.01) return p.toFixed(8);
  if (p < 1) return p.toFixed(6); return p.toFixed(4);
}
function writeCsvRow(e) {
  const d = new Date(e.timestamp);
  const qty = e.tradeSize && e.price ? (e.tradeSize/e.price).toFixed(6) : "";
  const fee = e.tradeSize ? (e.tradeSize * CONFIG.feeRate).toFixed(4) : "";
  const slp = e.tradeSize ? (e.tradeSize * CONFIG.slippagePct).toFixed(4) : "";
  const net = e.tradeSize ? (e.tradeSize - parseFloat(fee) - parseFloat(slp)).toFixed(2) : "";
  const mode = !e.allPass ? "BLOCKED" : e.paperTrading ? "PAPER" : IS_LIVE ? "LIVE" : "DEMO";
  appendFileSync(CSV_FILE, [d.toISOString().slice(0,10), d.toISOString().slice(11,19), "Binance", e.symbol, e.side||"", qty, e.price?fmtPrice(e.price):"", e.tradeSize?e.tradeSize.toFixed(2):"", fee, slp, net, e.realPnL!==undefined?e.realPnL.toFixed(4):"", e.orderId||"BLOCKED", mode, e.strategy||"", e.score||0, e.atrPct?e.atrPct.toFixed(3):"", e.rr?e.rr.toFixed(2):"", e.triggerSet||"", `"${e.notes||""}"`].join(",")+"\n");
}
function isDuplicateSignal(symbol, strategy, signal) {
  const cache = loadSigCache(); const key = `${symbol}_${strategy}`; const entry = cache[key];
  if (!entry) return false; const age = (Date.now() - entry.ts)/1000; return entry.signal===signal && age<3600;
}
function cacheSignal(symbol, strategy, signal) {
  const cache = loadSigCache(); cache[`${symbol}_${strategy}`] = { signal, ts: Date.now() }; saveSigCache(cache);
}
function checkDrawdown(balance) {
  const bh = loadBalanceHistory(); if (!bh.initialBalance) return { ok:true, drawdownPct:0 };
  const pct = ((balance - bh.initialBalance) / bh.initialBalance)*100;
  return { ok: pct > -CONFIG.maxDrawdown, drawdownPct: pct, initialBalance: bh.initialBalance };
}
function calcRealPnL(pos, exitPrice) {
  const qty = pos.sizeUSD / pos.entryPrice; const exitTot = qty * exitPrice;
  const fees = (pos.sizeUSD + exitTot) * CONFIG.feeRate; const slippage = (pos.sizeUSD + exitTot) * CONFIG.slippagePct;
  const gross = exitTot - pos.sizeUSD; return { gross, fees, slippage, net: gross - fees - slippage };
}
function updateStats(strategy, pnl, state) {
  if (!state.wins[strategy]) state.wins[strategy]=0; if (!state.losses[strategy]) state.losses[strategy]=0;
  if (!state.totalPnL[strategy]) state.totalPnL[strategy]=0;
  if (pnl.net > 0) state.wins[strategy]++; else state.losses[strategy]++;
  state.totalPnL[strategy] += pnl.net; state.totalFees = (state.totalFees||0) + pnl.fees;
  state.equityCurve = state.equityCurve || [];
  state.equityCurve.push({ timestamp: new Date().toISOString(), pnl: pnl.net, strategy });
  if (state.equityCurve.length > 500) state.equityCurve = state.equityCurve.slice(-500);
}
function getOptimizedAllocation(state) {
  const strategies = ['S1','S2','macd','enhanced_macd','bollinger','volatility'];
  const alloc = {};
  for (const s of strategies) {
    const w = state.wins?.[s]||0, l = state.losses?.[s]||0, t = w+l;
    const wr = t>=5 ? w/t : null;
    let pct = s==='S1'?CONFIG.s1Pct : s==='S2'?CONFIG.s2Pct : s==='enhanced_macd'?20 : s==='macd'?15 : s==='bollinger'?10 : 8;
    if (wr!==null) { if (wr>0.65) pct = Math.min(pct*1.2, 40); else if (wr<0.40) pct = Math.max(pct*0.7, 5); }
    alloc[s] = { pct, wr };
  }
  return alloc;
}
function getEquityScaler(balance) {
  const bh = loadBalanceHistory(); if (!bh.initialBalance) return 1.0;
  return Math.max(0.5, Math.min(1.2, balance / bh.initialBalance));
}

// ─── Indicators (Full Suite) ──────────────────────────────────────────────────
function calcSMA(arr, p) { if (arr.length<p) return null; const s=arr.slice(-p); return s.reduce((a,b)=>a+b,0)/p; }
function calcEMA(closes, period) {
  if (closes.length<period) return closes[closes.length-1]||0;
  const k = 2/(period+1); let e = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period; i<closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}
function calcRSI(closes, period) {
  if (closes.length<period+1) return 50;
  let g=0,l=0;
  for (let i=closes.length-period; i<closes.length; i++) { const d=closes[i]-closes[i-1]; if (d>0) g+=d; else l-=d; }
  if (l===0) return 100; return 100 - 100/(1 + (g/period)/(l/period));
}
function calcStochRSI(closes) {
  if (closes.length<28) return { k:50, d:50, oversold:false, overbought:false };
  const rv=[]; for (let i=14; i<=closes.length; i++) rv.push(calcRSI(closes.slice(0,i),14));
  const recent=rv.slice(-14); const minR=Math.min(...recent), maxR=Math.max(...recent);
  const rawK = maxR===minR?50:((rv[rv.length-1]-minR)/(maxR-minR))*100;
  const d = (rawK + (rv.length>1?((rv[rv.length-2]-minR)/(maxR-minR))*100:rawK) + (rv.length>2?((rv[rv.length-3]-minR)/(maxR-minR))*100:rawK))/3;
  return { k:rawK, d, oversold:rawK<20, overbought:rawK>80 };
}
function calcMACD(closes, fast=12, slow=26, signal=9) {
  if (closes.length<slow) return { macdLine:0, signalLine:0, histogram:0 };
  const mv=[]; for (let i=slow; i<=closes.length; i++) { const sl=closes.slice(0,i); mv.push(calcEMA(sl,fast)-calcEMA(sl,slow)); }
  const macdLine=mv[mv.length-1]; const signalLine=calcEMA(mv,signal);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}
function calcBB(closes, period=20, stdDev=2) {
  if (closes.length<period) return { upper:0, middle:0, lower:0, bandwidth:0, percentB:0 };
  const slice=closes.slice(-period); const sma=slice.reduce((a,b)=>a+b,0)/period;
  const variance=slice.reduce((s,c)=>s+Math.pow(c-sma,2),0)/period; const std=Math.sqrt(variance);
  const upper=sma+stdDev*std, lower=sma-stdDev*std; const price=closes[closes.length-1];
  return { upper, middle:sma, lower, bandwidth:(upper-lower)/sma, percentB:(price-lower)/(upper-lower) };
}
function calcVWAP(candles) {
  const midnight=new Date(); midnight.setUTCHours(0,0,0,0);
  const sess=candles.filter(c=>c.time>=midnight.getTime()); if (!sess.length) return candles[candles.length-1].close;
  const tpv=sess.reduce((s,c)=>s+((c.high+c.low+c.close)/3)*c.volume,0);
  const vol=sess.reduce((s,c)=>s+c.volume,0); return vol?tpv/vol:candles[candles.length-1].close;
}
function calcCMF(candles, period=20) {
  if (candles.length<period) return 0; const recent=candles.slice(-period);
  const mfv=recent.map(c=>{ const hl=c.high-c.low; return hl===0?0:((c.close-c.low)-(c.high-c.close))/hl*c.volume; });
  const sumMFV=mfv.reduce((a,b)=>a+b,0); const sumVol=recent.reduce((s,c)=>s+c.volume,0);
  return sumVol?sumMFV/sumVol:0;
}
function calcATR(candles, period=14) {
  if (candles.length<period+1) return 0;
  const trs=candles.slice(-period-1).map((c,i,arr)=> i===0?c.high-c.low : Math.max(c.high-c.low, Math.abs(c.high-arr[i-1].close), Math.abs(c.low-arr[i-1].close)));
  return trs.slice(1).reduce((a,b)=>a+b,0)/period;
}
function calcRSIDivergence(closes, period=14, lookback=5) {
  if (closes.length<period+lookback+2) return { bullish:false, bearish:false };
  const rsiNow=calcRSI(closes,period), rsiPrev=calcRSI(closes.slice(0,-lookback),period);
  const pNow=closes[closes.length-1], pPrev=closes[closes.length-1-lookback];
  return { bullish: pNow<pPrev && rsiNow>rsiPrev, bearish: pNow>pPrev && rsiNow<rsiPrev };
}
function calcTDSequential(closes) {
  if (closes.length<10) return { count:0, setup:null, upCount:0, downCount:0 };
  let up=0, dn=0;
  for (let i=closes.length-1; i>=4; i--) {
    if (closes[i]>closes[i-4]) { if (dn===0) up++; else break; }
    else if (closes[i]<closes[i-4]) { if (up===0) dn++; else break; }
    else break;
  }
  return { count: Math.max(up,dn), setup: up>=9?"SELL_9":dn>=9?"BUY_9":null, upCount:up, downCount:dn };
}
function calcFibLevels(closes, lookback=50) {
  const recent=closes.slice(-Math.min(lookback,closes.length));
  const high=Math.max(...recent), low=Math.min(...recent), range=high-low||1, price=closes[closes.length-1];
  const f618=high-range*0.618, f50=high-range*0.5;
  return { high, low, fib618:f618, fib50:f50, nearFib618: Math.abs(price-f618)/f618<0.015, nearFib50: Math.abs(price-f50)/f50<0.015 };
}

// ─── AI Score Engine (restored) ───────────────────────────────────────────────
function calcAIScore(d, ob, m5, direction) {
  let score = 0;
  const buy = direction === "BUY";
  if (buy) { if (d.rsi14 < 35) score += 20; else if (d.rsi14 < 50) score += 10; }
  else { if (d.rsi14 > 65) score += 20; else if (d.rsi14 > 50) score += 10; }
  if (buy) { if (d.cmf > 0.05) score += 20; else if (d.cmf > 0) score += 10; }
  else { if (d.cmf < -0.05) score += 20; else if (d.cmf < 0) score += 10; }
  if (buy && d.rsiDiv?.bullish) score += 15;
  if (!buy && d.rsiDiv?.bearish) score += 15;
  if (buy && d.tdSeq?.setup === "BUY_9") score += 15;
  if (!buy && d.tdSeq?.setup === "SELL_9") score += 15;
  if (d.volConfirmed) score += 10;
  if (ob) {
    if (buy && ob.bullish) score += 15;
    else if (buy && ob.imbalance > 1.0) score += 7;
    if (!buy && ob.bearish) score += 15;
    else if (!buy && ob.imbalance < 1.0) score += 7;
    if (ob.spread > 0.1) score -= 5;
  }
  if (m5) {
    if (buy && m5.bullish) score += 10;
    if (!buy && m5.bearish) score += 10;
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
  const closes = candles.map(c=>c.close); const price = closes[closes.length-1];
  const ema5=calcEMA(closes,5), ema8=calcEMA(closes,8), ema13=calcEMA(closes,13), ema21=calcEMA(closes,21), ema50=calcEMA(closes,50), ema200=calcEMA(closes,200);
  const rsi3=calcRSI(closes,3), rsi14=calcRSI(closes,14), stochRSI=calcStochRSI(closes), macdData=calcMACD(closes);
  const bb=calcBB(closes), vwap=calcVWAP(candles), cmf=calcCMF(candles), rsiDiv=calcRSIDivergence(closes);
  const tdSeq=calcTDSequential(closes), fib=calcFibLevels(closes), atr=calcATR(candles), atrPct=price>0?(atr/price)*100:0;
  const vols=candles.map(c=>c.volume), avgVol20=vols.slice(-20).reduce((a,b)=>a+b,0)/20, currentVol=vols[vols.length-1];
  const volConfirmed=currentVol>avgVol20*1.1;
  const last=candles[candles.length-1], prev=candles[candles.length-2];
  const body=Math.abs(last.close-last.open), wick=(last.high-last.low)||0.0001;
  return {
    symbol, price, candles, closes, ema5, ema8, ema13, ema21, ema50, ema200, rsi3, rsi14, stochRSI, macdData, bb, vwap, cmf, rsiDiv, tdSeq, fib,
    atr, atrPct, volConfirmed, strongGreen: last.close>last.open && body/wick>0.6, strongRed: last.close<last.open && body/wick>0.6,
    momentum: last.close-prev.close,
  };
}

// ─── Strategies (now use AI score) ────────────────────────────────────────────
function strategyS1(d, ob, m5) {
  const { price, ema5, ema8, ema13, ema21, ema50, ema200, rsi3, rsi14, stochRSI, macdData, bb, vwap, cmf, rsiDiv, tdSeq, fib, volConfirmed, strongGreen, strongRed, momentum } = d;
  const ribbonBull=ema5>ema8&&ema8>ema13&&ema13>ema21&&ema21>ema50, ribbonBear=ema5<ema8&&ema8<ema13&&ema13<ema21&&ema21<ema50;
  const goldenZone=price>ema50&&price>ema200, nearEMA200=price>ema200&&price<=ema200*1.02;
  const aboveVWAP=price>vwap, belowVWAP=price<vwap;
  const macdBull=macdData.macdLine>macdData.signalLine, macdBear=macdData.macdLine<macdData.signalLine;
  const macdCrossUp=macdData.histogram>0, macdCrossDown=macdData.histogram<0;
  const nearBBLower=price<=bb.lower*1.005, nearBBUpper=price>=bb.upper*0.995;
  const cmfBull=cmf>0.05, cmfBear=cmf<-0.05, posMom=momentum>0, negMom=momentum<0;
  const stochOS=stochRSI.oversold, stochOB=stochRSI.overbought;
  const setA = ribbonBull && goldenZone && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setB = ema8>ema21 && ema21>ema50 && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  const setC = nearBBLower && rsi3<20 && (stochOS||rsi14<35) && ema8>ema21 && posMom;
  const setD = nearEMA200 && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setE_buy = fib.nearFib618 && ribbonBull && goldenZone && rsi14<50 && (cmfBull||macdBull) && posMom;
  const setF_buy = rsiDiv.bullish && cmfBull && macdBull && ema8>ema21 && volConfirmed;
  const setG = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed && cmfBear;
  const setH = rsi3>80 && nearBBUpper && (stochOB||rsi14>65) && macdCrossDown && negMom;
  const setI = (tdSeq.setup==="SELL_9"||rsiDiv.bearish) && cmfBear && macdBear && price<ema21;
  const setJ = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;
  const buySignal = setA||setB||setC||setD||setE_buy||setF_buy;
  const sellSignal = setG||setH||setI||setJ;
  let signal = null;
  if (buySignal && !sellSignal) signal = "BUY";
  else if (sellSignal && !buySignal) signal = "SELL";
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "S1", details: { setA,setB,setC,setD,setE_buy,setF_buy,setG,setH,setI,setJ } };
}

function strategyS2(d, ob, m5) {
  const { price, ema8, ema21, ema50, rsi14, macdData, bb, vwap, cmf, rsiDiv, tdSeq, fib, volConfirmed, momentum } = d;
  const emaStackBull=ema8>ema21&&ema21>ema50, emaStackBear=ema8<ema21&&ema21<ema50;
  const aboveVWAP=price>vwap, belowVWAP=price<vwap;
  const macdBull=macdData.macdLine>macdData.signalLine, macdBear=macdData.macdLine<macdData.signalLine;
  const nearBBLower=price<=bb.lower*1.02, nearBBUpper=price>=bb.upper*0.98;
  const cmfPos=cmf>0, cmfNeg=cmf<0, posMom=momentum>0, negMom=momentum<0;
  const setA2 = emaStackBull && rsi14<55 && (macdBull||cmfPos) && aboveVWAP;
  const setB2 = (fib.nearFib618||fib.nearFib50) && emaStackBull && rsi14<60 && posMom;
  const setC2 = nearBBLower && rsi14<45 && posMom && (emaStackBull||price>ema50);
  const setD2 = rsiDiv.bullish && (emaStackBull||price>ema50) && posMom;
  const setE2 = tdSeq.setup==="BUY_9" && (macdBull||cmfPos);
  const setF2 = emaStackBear && (macdBear||cmfNeg) && belowVWAP;
  const setG2 = nearBBUpper && rsi14>60 && negMom;
  const setH2 = (rsiDiv.bearish||tdSeq.setup==="SELL_9") && (macdBear||cmfNeg);
  const buySignal = setA2||setB2||setC2||setD2||setE2;
  const sellSignal = setF2||setG2||setH2;
  let signal = null;
  if (buySignal && !sellSignal) signal = "BUY";
  else if (sellSignal && !buySignal) signal = "SELL";
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "S2", details: { setA2,setB2,setC2,setD2,setE2,setF2,setG2,setH2 } };
}

function strategyMACD(d, ob, m5) {
  const { price, ema50, macdData, volConfirmed } = d;
  const buy = macdData.macdLine > macdData.signalLine && price > ema50 && volConfirmed;
  const sell = macdData.macdLine < macdData.signalLine && price < ema50;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "macd", details: { buy, sell } };
}

function strategyEnhancedMACD(d, ob, m5) {
  const { price, ema50, ema200, rsi14, macdData, bb, cmf, volConfirmed } = d;
  const trendBull = price > ema50 && ema50 > ema200, trendBear = price < ema50 && ema50 < ema200;
  const macdBull = macdData.macdLine > macdData.signalLine && macdData.histogram > 0;
  const macdBear = macdData.macdLine < macdData.signalLine && macdData.histogram < 0;
  const buy = trendBull && macdBull && rsi14 < 60 && price > bb.lower && price < bb.upper && volConfirmed && cmf > 0.05;
  const sell = trendBear && macdBear && rsi14 > 40 && price > bb.lower && price < bb.upper && volConfirmed && cmf < -0.05;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "enhanced_macd", details: { buy, sell } };
}

function strategyBollinger(d, ob, m5) {
  const { price, bb, rsi14, stochRSI, volConfirmed } = d;
  const nearLower = price <= bb.lower * 1.02, nearUpper = price >= bb.upper * 0.98;
  const buy = nearLower && rsi14 < 35 && stochRSI.k < 20 && volConfirmed;
  const sell = nearUpper && rsi14 > 65 && stochRSI.k > 80 && volConfirmed;
  const signal = buy ? "BUY" : sell ? "SELL" : null;
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "bollinger", details: { buy, sell } };
}

function strategyVolatility(d, ob, m5) {
  const { price, candles, volConfirmed, momentum } = d;
  const period = 20;
  // Exclude current candle from channel calculation
  const prevCandles = candles.slice(-period-1, -1);
  const highs = prevCandles.map(c => c.high), lows = prevCandles.map(c => c.low);
  const highest = Math.max(...highs), lowest = Math.min(...lows);
  const breakoutUp = price > highest && momentum > 0 && volConfirmed;
  const breakoutDown = price < lowest && momentum < 0 && volConfirmed;
  const signal = breakoutUp ? "BUY" : breakoutDown ? "SELL" : null;
  const score = signal ? calcAIScore(d, ob, m5, signal) : 0;
  return { signal, score, strategy: "volatility", details: { breakoutUp, breakoutDown } };
}

// ─── Execute Signal ───────────────────────────────────────────────────────────
async function executeSignal(symbol, signal, strategy, score, price, atr, balance, equityScaler, allocPct, logEntry) {
  const existing = loadPositions().find(p => p.symbol === symbol && p.strategy === strategy);
  if (existing) { console.log(`   ⚠️ [${strategy}] Skipping — open position @ ${fmtPrice(existing.entryPrice)}`); return; }
  const allPositions = loadPositions();
  if (allPositions.length >= CONFIG.maxPositions) { console.log(`   ⚠️ Max positions (${allPositions.length}/${CONFIG.maxPositions}) — skipping`); return; }

  // Use allocation percentage for trade size
  const riskAmount = balance * (allocPct / 100) * equityScaler;
  const stopDist = atr * 1.5, priceRisk = stopDist / price;
  const sizeByRisk = priceRisk > 0 ? riskAmount / priceRisk : 0;
  const size = Math.min(sizeByRisk, balance * 0.4, CONFIG.maxTradeUSD);
  const stopPrice = signal==="BUY" ? price * (1 - priceRisk) : price * (1 + priceRisk);
  const tpPrice = signal==="BUY" ? price * (1 + (stopDist * CONFIG.rrRatio / price)) : price * (1 - (stopDist * CONFIG.rrRatio / price));

  logEntry.tradeSize = size; logEntry.signal = signal; logEntry.triggerSet = strategy;
  logEntry.allPass = true; logEntry.score = score; logEntry.atrPct = (atr/price*100); logEntry.rr = CONFIG.rrRatio;

  if (CONFIG.paperTrading) {
    logEntry.orderPlaced = true; logEntry.orderId = `PAPER-${Date.now()}`; logEntry.side = signal;
    console.log(`   📋 PAPER ${signal} $${size.toFixed(2)} @ ${fmtPrice(price)} | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(stopPrice)}`);
  } else {
    try {
      const qty = size / price;
      const order = await placeMarketOrder(symbol, signal, qty);
      logEntry.orderPlaced = true; logEntry.orderId = String(order.orderId); logEntry.side = signal;
      console.log(`   ✅ LIVE ${signal} ID:${order.orderId} | Size:$${size.toFixed(2)}`);
    } catch (err) {
      console.log(`   ❌ Order failed: ${err.message}`); logEntry.notes = `Failed: ${err.message}`;
    }
  }

  if (logEntry.orderPlaced && signal === "BUY") {
    const positions = loadPositions();
    positions.push({ symbol, entryPrice: price, sizeUSD: size, strategy, timestamp: new Date().toISOString(), tpPrice, slPrice: stopPrice, rr: CONFIG.rrRatio });
    savePositions(positions);
    cacheSignal(symbol, strategy, signal);
  }
}

// ─── TP/SL + Trailing Stop (with save) ────────────────────────────────────────
async function checkExits(symbol, price, botState) {
  const all = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others = all.filter(p => p.symbol !== symbol);
  const remaining = [];
  let changed = false;
  for (const pos of positions) {
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    let slPrice = pos.slPrice || (pos.entryPrice * (1 - CONFIG.stopLossPct/100));
    const tpPrice = pos.tpPrice || (pos.entryPrice * (1 + CONFIG.takeProfitPct/100));
    if (pnlPct >= CONFIG.trailingActivate) {
      const trailPrice = price * (1 - CONFIG.trailingStopPct/100);
      if (trailPrice > slPrice) {
        slPrice = trailPrice;
        pos.slPrice = slPrice;
        changed = true;
      }
    }
    if (price >= tpPrice || price <= slPrice) {
      const reason = price >= tpPrice ? "TAKE_PROFIT" : "STOP_LOSS";
      const pnl = calcRealPnL(pos, price);
      updateStats(pos.strategy, pnl, botState);
      console.log(`   ${reason==="TAKE_PROFIT"?"✅":"🛑"} [${pos.strategy}] ${symbol} ${reason} | Net:$${pnl.net.toFixed(3)}`);
      if (!CONFIG.paperTrading) { const qty = pos.sizeUSD / price; await placeMarketOrder(symbol, "SELL", qty); }
      writeCsvRow({ timestamp: new Date().toISOString(), symbol, price, tradeSize: pos.sizeUSD, allPass: true, paperTrading: CONFIG.paperTrading, orderPlaced: true, orderId: `EXIT-${Date.now()}`, side: "SELL", notes: reason, strategy: pos.strategy, realPnL: pnl.net });
    } else {
      remaining.push(pos);
    }
  }
  if (changed) savePositions([...others, ...remaining]);
  else if (remaining.length !== positions.length) savePositions([...others, ...remaining]);
}

// ─── Morning Brief ────────────────────────────────────────────────────────────
async function morningBrief() {
  const botState = loadState();
  const alloc = getOptimizedAllocation(botState);
  const balance = await fetchAccountBalance();
  const dd = checkDrawdown(balance);
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        TradeBotIQ v4.6e — MORNING BRIEF                  ║");
  console.log(`║        ${new Date().toUTCString().slice(0,51).padEnd(51)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  console.log(`  Balance: $${balance.toFixed(2)} | DD:${dd.drawdownPct.toFixed(1)}% | ${dd.ok?"🟢":"🛑"}`);
  for (const s of Object.keys(alloc)) {
    const a = alloc[s];
    console.log(`  ${s.padEnd(15)} WR:${a.wr!==null?(a.wr*100).toFixed(0)+"%":"new"} (${a.pct.toFixed(0)}%)`);
  }
  console.log("");
  for (const symbol of CONFIG.assets.slice(0,5)) {
    const d = await analyzeAsset(symbol);
    const ob = await fetchOrderBook(symbol);
    const m5 = await get5mConfirmation(symbol);
    const s1 = strategyS1(d, ob, m5);
    const s2 = strategyS2(d, ob, m5);
    console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | S1:${s1.signal?`${s1.signal}(${s1.score})`:"⚪"} | S2:${s2.signal?`${s2.signal}(${s2.score})`:"⚪"}`);
  }
  writeFileSync(BRIEF_FILE, JSON.stringify({ timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n  Brief saved → ${BRIEF_FILE}\n`);
}

// ─── PineScript Export (Full Implementation) ──────────────────────────────────
function exportPineScript() {
  const pine = `//@version=5
strategy("TradeBotIQ v4.6e — Ed25519 Live", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1)

// ─── EMAs ─────────────────────────────────────────────────────────────────────
ema5  = ta.ema(close,5)
ema8  = ta.ema(close,8)
ema13 = ta.ema(close,13)
ema21 = ta.ema(close,21)
ema50 = ta.ema(close,50)
ema200= ta.ema(close,200)
plot(ema5, color=color.lime, linewidth=1)
plot(ema8, color=color.green, linewidth=1)
plot(ema13,color=color.teal, linewidth=1)
plot(ema21,color=color.blue, linewidth=2)
plot(ema50,color=color.orange, linewidth=2)
plot(ema200,color=color.red, linewidth=3)

// ─── RSI ──────────────────────────────────────────────────────────────────────
rsi3  = ta.rsi(close,3)
rsi14 = ta.rsi(close,14)

// ─── MACD ─────────────────────────────────────────────────────────────────────
[macdLine, signalLine, hist] = ta.macd(close, 12, 26, 9)

// ─── Bollinger Bands ──────────────────────────────────────────────────────────
[bbUpper, bbMiddle, bbLower] = ta.bb(close, 20, 2)

// ─── VWAP ─────────────────────────────────────────────────────────────────────
vwapVal = ta.vwap(hlc3)

// ─── CMF (Chaikin Money Flow) ─────────────────────────────────────────────────
mfv = ((close-low) - (high-close)) / (high-low == 0 ? 1 : high-low) * volume
cmf = ta.sma(mfv, 20) / ta.sma(volume, 20)

// ─── Volume Confirmation ──────────────────────────────────────────────────────
volOk = volume > ta.sma(volume, 20) * 1.1

// ─── Fibonacci Levels ─────────────────────────────────────────────────────────
ph = ta.highest(high, 50)
pl = ta.lowest(low, 50)
fib618 = ph - (ph - pl) * 0.618
fib50  = ph - (ph - pl) * 0.5
plot(fib618, color=color.new(color.yellow,50), linewidth=1, title="Fib 61.8%")
plot(fib50,  color=color.new(color.yellow,70), linewidth=1, title="Fib 50%")

// ─── RSI Divergence ───────────────────────────────────────────────────────────
rsiPrev = rsi14[5]
bullDiv = close < close[5] and rsi14 > rsiPrev
bearDiv = close > close[5] and rsi14 < rsiPrev

// ─── TD Sequential (simplified) ───────────────────────────────────────────────
upCount = 0, downCount = 0
upCount := close > close[4] ? (downCount == 0 ? upCount[1] + 1 : 1) : 0
downCount := close < close[4] ? (upCount == 0 ? downCount[1] + 1 : 1) : 0
buy9  = downCount >= 9
sell9 = upCount >= 9

// ─── Trend & Momentum ─────────────────────────────────────────────────────────
ribbonBull = ema5>ema8 and ema8>ema13 and ema13>ema21 and ema21>ema50
ribbonBear = ema5<ema8 and ema8<ema13 and ema13<ema21 and ema21<ema50
goldenZone = close>ema50 and close>ema200
body = math.abs(close-open)
wick = math.max(high-low, 0.0001)
strongGreen = close>open and body/wick>0.6
strongRed   = close<open and body/wick>0.6

// ─── S1 Strategy Sets ────────────────────────────────────────────────────────
s1A = ribbonBull and goldenZone and rsi14<35 and macdLine>signalLine and volOk and cmf>0.05
s1B = ema8>ema21 and ema21>ema50 and strongGreen and hist>0 and close>vwapVal and volOk
s1C = close<=bbLower*1.005 and rsi3<20 and rsi14<35 and ema8>ema21 and close>close[1]
s1D = close>ema200 and close<=ema200*1.02 and rsi14<35 and macdLine>signalLine and volOk and cmf>0.05
s1E = math.abs(close-fib618)/fib618<0.015 and ribbonBull and goldenZone and rsi14<50 and cmf>0
s1F = bullDiv and cmf>0.05 and macdLine>signalLine and ema8>ema21 and volOk

s1G = ribbonBear and macdLine<signalLine and close<vwapVal and close<ema21 and volOk and cmf<-0.05
s1H = rsi3>80 and close>=bbUpper*0.995 and rsi14>65 and hist<0 and close<close[1]
s1I = (sell9 or bearDiv) and cmf<-0.05 and macdLine<signalLine and close<ema21
s1J = strongRed and close<ema21 and close<ema50 and macdLine<signalLine and close<vwapVal

// ─── S2 Strategy Sets ────────────────────────────────────────────────────────
s2A = ema8>ema21 and ema21>ema50 and rsi14<55 and (macdLine>signalLine or cmf>0) and close>vwapVal
s2B = (math.abs(close-fib618)/fib618<0.015 or math.abs(close-fib50)/fib50<0.015) and ema8>ema21 and rsi14<60 and close>close[1]
s2C = close<=bbLower*1.02 and rsi14<45 and close>close[1] and (ema8>ema21 or close>ema50)
s2D = bullDiv and (ema8>ema21 or close>ema50) and close>close[1]
s2E = buy9 and (macdLine>signalLine or cmf>0)
s2F = ema8<ema21 and ema21<ema50 and (macdLine<signalLine or cmf<0) and close<vwapVal
s2G = close>=bbUpper*0.98 and rsi14>60 and close<close[1]
s2H = (bearDiv or sell9) and (macdLine<signalLine or cmf<0)

// ─── Signal Aggregation ───────────────────────────────────────────────────────
s1Buy  = (s1A or s1B or s1C or s1D or s1E or s1F) and not (s1G or s1H or s1I or s1J)
s1Sell = (s1G or s1H or s1I or s1J) and not (s1A or s1B or s1C or s1D or s1E or s1F)
s2Buy  = (s2A or s2B or s2C or s2D or s2E) and not s1Sell
s2Sell = (s2F or s2G or s2H) and not s1Buy

// ─── Strategy Entries ─────────────────────────────────────────────────────────
if s1Buy
    strategy.entry("S1", strategy.long, qty=30)
    strategy.exit("S1x", "S1", profit=close*0.035/syminfo.mintick, loss=close*0.01/syminfo.mintick)
if s2Buy
    strategy.entry("S2", strategy.long, qty=5)
    strategy.exit("S2x", "S2", profit=close*0.035/syminfo.mintick, loss=close*0.01/syminfo.mintick)
if s1Sell
    strategy.close_all(comment="S1 Sell")
if s2Sell
    strategy.close("S2", comment="S2 Sell")

// ─── Visuals ──────────────────────────────────────────────────────────────────
plotshape(s1Buy,  location=location.belowbar, color=color.green, style=shape.labelup, text="S1")
plotshape(s2Buy,  location=location.belowbar, color=color.lime,  style=shape.triangleup, text="S2")
plotshape(s1Sell, location=location.abovebar, color=color.red,   style=shape.labeldown, text="SELL")
bgcolor(goldenZone ? color.new(color.green,95) : color.new(color.red,95))
alertcondition(s1Buy,  "S1 BUY",  "TradeBotIQ S1 BUY: {{ticker}} @ {{close}}")
alertcondition(s2Buy,  "S2 BUY",  "TradeBotIQ S2 BUY: {{ticker}} @ {{close}}")
alertcondition(s1Sell, "SELL",    "TradeBotIQ SELL: {{ticker}} @ {{close}}")
`;
  writeFileSync("TradeBotIQ.pine", pine);
  console.log("✅ PineScript v4.6e saved → TradeBotIQ.pine");
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();
  cleanCache();
  if (process.argv.includes("--brief")) { await morningBrief(); return; }
  if (process.argv.includes("--pine")) { exportPineScript(); return; }

  const botState = loadState();
  const balance = await fetchAccountBalance();
  const equityScaler = getEquityScaler(balance);
  const dd = checkDrawdown(balance);
  if (!dd.ok) { console.log(`🛑 MAX DRAWDOWN BREACHED — Bot paused (${dd.drawdownPct.toFixed(1)}%)`); return; }

  const alloc = getOptimizedAllocation(botState);
  const log = loadLog();
  const activeList = CONFIG.activeStrategies.includes("all") ? ["S1","S2","macd","enhanced_macd","bollinger","volatility"] : CONFIG.activeStrategies;

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v4.6e — Pure Custom REST (Ed25519)");
  console.log(`  ${new Date().toISOString()} | Mode: ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | Balance: $${balance.toFixed(2)}`);
  console.log(`  Active Strategies: ${activeList.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.paperTrading) saveBalance(balance);

  for (const symbol of CONFIG.assets) {
    await new Promise(r => setTimeout(r, 1200));
    const d = await analyzeAsset(symbol);
    const ob = await fetchOrderBook(symbol);
    const m5 = await get5mConfirmation(symbol);
    await checkExits(symbol, d.price, botState);

    const strategyFns = { S1: strategyS1, S2: strategyS2, macd: strategyMACD, enhanced_macd: strategyEnhancedMACD, bollinger: strategyBollinger, volatility: strategyVolatility };
    for (const stratName of activeList) {
      if (!strategyFns[stratName]) continue;
      const res = strategyFns[stratName](d, ob, m5);
      if (!res.signal) continue;

      const minScore = stratName==="S1" ? CONFIG.minScoreS1 : stratName==="S2" ? CONFIG.minScoreS2 : CONFIG.minScoreGeneral;
      if (res.score < minScore) continue;
      if (isDuplicateSignal(symbol, stratName, res.signal)) continue;
      if (countTodaysTrades(log, symbol, stratName) >= CONFIG.maxTradesPerDay) continue;

      const allocPct = alloc[stratName]?.pct || (stratName==="S1"?CONFIG.s1Pct : stratName==="S2"?CONFIG.s2Pct : 20);
      const tradeSize = Math.min(balance * (allocPct/100), CONFIG.maxTradeUSD);
      console.log(`   🎯 ${stratName} ${res.signal} | Score:${res.score} | $${tradeSize.toFixed(2)}`);

      const logEntry = { timestamp: new Date().toISOString(), symbol, price: d.price, tradeSize, paperTrading: CONFIG.paperTrading, strategy: stratName };
      await executeSignal(symbol, res.signal, stratName, res.score, d.price, d.atr, balance, equityScaler, allocPct, logEntry);
      log.trades.push(logEntry);
      writeCsvRow(logEntry);
    }
  }

  saveLog(log);
  saveState(botState);
  console.log(`\n✅ Done | Balance:$${balance.toFixed(2)} | Pos:${loadPositions().length}/${CONFIG.maxPositions} | DD:${dd.drawdownPct.toFixed(1)}%`);
}

run().catch(err => { console.error("Bot error:", err.stack || err.message); process.exit(1); });
