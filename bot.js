/**
 * TradeBotIQ v3.2 — FIXED: Full execution restored + all sell sets + PEPE decimals
 * Research: CoinsKid + TA Analyst + Benjamin Cowen + Crypto Kirby
 * EMA Ribbon + StochRSI + MACD + BB + VWAP | Buy A-D | Sell E-G
 */

import "dotenv/config";
import ccxt from "ccxt";
import { writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const TRADING_ACCOUNT = (process.env.TRADING_ACCOUNT || "demo").toLowerCase();
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const IS_LIVE         = TRADING_ACCOUNT === "live" && !PAPER_TRADING;

const CONFIG = {
  assets:          (process.env.ASSETS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,LINKUSDT,PEPEUSDT").split(","),
  timeframe:       (process.env.TIMEFRAME || "1H").toLowerCase(),
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSize:    parseFloat(process.env.MAX_TRADE_SIZE_USD  || "35"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY   || "31"),
  takeProfitPct:   parseFloat(process.env.TAKE_PROFIT_PCT    || "3.5"),
  stopLossPct:     parseFloat(process.env.STOP_LOSS_PCT      || "1.0"),
  riskPerTrade:    parseFloat(process.env.RISK_PCT           || "1.0"),
  paperTrading:    PAPER_TRADING,
  isLive:          IS_LIVE,
};

// ─── Exchange ─────────────────────────────────────────────────────────────────
function createExchange() {
  const ex = new ccxt.binance({
    apiKey: IS_LIVE ? process.env.BINANCE_API_KEY : process.env.BINANCE_DEMO_API_KEY,
    secret: IS_LIVE ? process.env.BINANCE_SECRET_KEY : process.env.BINANCE_DEMO_SECRET_KEY,
    enableRateLimit: true,
    options: { defaultType: "spot", adjustForTimeDifference: true },
  });
  if (!IS_LIVE) ex.setSandboxMode(true);
  return ex;
}

// ─── Files ────────────────────────────────────────────────────────────────────
const LOG_FILE       = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";
const CSV_FILE       = "trades.csv";
const BRIEF_FILE     = "morning-brief.json";
const CSV_HEADERS    = "Date,Time(UTC),Exchange,Symbol,Side,Qty,Price,USD,Fee,Net,OrderID,Mode,Set,Notes";

function initFiles() {
  if (!existsSync(CSV_FILE))       writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  if (!existsSync(LOG_FILE))       writeFileSync(LOG_FILE, JSON.stringify({ trades: [] }, null, 2));
  if (!existsSync(POSITIONS_FILE)) writeFileSync(POSITIONS_FILE, "[]");
}

function loadLog()        { return existsSync(LOG_FILE) ? JSON.parse(readFileSync(LOG_FILE,"utf8")) : { trades:[] }; }
function saveLog(l)       { writeFileSync(LOG_FILE, JSON.stringify(l, null, 2)); }
function loadPositions()  { return existsSync(POSITIONS_FILE) ? JSON.parse(readFileSync(POSITIONS_FILE,"utf8")) : []; }
function savePositions(p) { writeFileSync(POSITIONS_FILE, JSON.stringify(p, null, 2)); }

function countTodaysTrades(log, symbol) {
  const today = new Date().toISOString().slice(0,10);
  return log.trades.filter(t => t.timestamp?.startsWith(today) && t.orderPlaced && t.symbol === symbol).length;
}

// Smart price formatting — handles PEPE tiny decimals
function fmtPrice(price) {
  if (price === 0 || price === null) return "0";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01)   return price.toFixed(8);
  if (price < 1)      return price.toFixed(6);
  return price.toFixed(4);
}

function writeCsvRow(e) {
  const d   = new Date(e.timestamp);
  const qty = e.tradeSize && e.price ? (e.tradeSize / e.price).toFixed(6) : "";
  const fee = e.tradeSize ? (e.tradeSize * 0.001).toFixed(4) : "";
  const net = e.tradeSize ? (e.tradeSize - e.tradeSize*0.001).toFixed(2) : "";
  const mode = !e.allPass ? "BLOCKED" : e.paperTrading ? "PAPER" : IS_LIVE ? "LIVE" : "DEMO";
  appendFileSync(CSV_FILE, [
    d.toISOString().slice(0,10), d.toISOString().slice(11,19),
    "Binance", e.symbol, e.side||"", qty,
    e.price ? fmtPrice(e.price) : "",
    e.tradeSize ? e.tradeSize.toFixed(2) : "",
    fee, net, e.orderId||"BLOCKED", mode,
    e.triggerSet||"", `"${e.notes||""}"`
  ].join(",") + "\n");
}

// ─── Market Data ──────────────────────────────────────────────────────────────
async function fetchCandles(symbol, interval, limit = 500) {
  const map = {"1h":"1h","2h":"2h","4h":"4h","1d":"1d"};
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${map[interval]||"1h"}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol}: ${res.status}`);
  return (await res.json()).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i]*k + e*(1-k);
  return e;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + (g/period) / (l/period));
}

function calcStochRSI(closes) {
  if (closes.length < 28) return null;
  const rsiVals = [];
  for (let i = 14; i <= closes.length; i++) rsiVals.push(calcRSI(closes.slice(0,i), 14));
  const recent = rsiVals.slice(-14);
  const minR   = Math.min(...recent);
  const maxR   = Math.max(...recent);
  const rawK   = maxR === minR ? 50 : ((rsiVals[rsiVals.length-1] - minR) / (maxR - minR)) * 100;
  return { k: rawK, oversold: rawK < 20, overbought: rawK > 80 };
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const macdVals = [];
  for (let i = 26; i <= closes.length; i++) {
    const sl = closes.slice(0,i);
    macdVals.push(calcEMA(sl,12) - calcEMA(sl,26));
  }
  const macdLine   = macdVals[macdVals.length-1];
  const signalLine = calcEMA(macdVals, 9);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}

function calcBB(closes) {
  if (closes.length < 20) return null;
  const slice = closes.slice(-20);
  const sma   = slice.reduce((a,b)=>a+b,0) / 20;
  const std   = Math.sqrt(slice.reduce((s,c) => s + Math.pow(c-sma,2), 0) / 20);
  return { upper: sma+2*std, middle: sma, lower: sma-2*std };
}

function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol = sess.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv/vol : null;
}

// ─── Asset Analysis ───────────────────────────────────────────────────────────
async function analyzeAsset(symbol) {
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 500);
  const closes  = candles.map(c => c.close);
  const price   = closes[closes.length-1];

  const ema5=calcEMA(closes,5); const ema8=calcEMA(closes,8); const ema13=calcEMA(closes,13);
  const ema21=calcEMA(closes,21); const ema50=calcEMA(closes,50); const ema200=calcEMA(closes,200);
  const rsi3=calcRSI(closes,3); const rsi14=calcRSI(closes,14);
  const stochRSI=calcStochRSI(closes);
  const macdData=calcMACD(closes);
  const bb=calcBB(closes);
  const vwapVal=calcVWAP(candles);

  const vols      = candles.map(c => c.volume);
  const avgVol20  = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const currentVol = vols[vols.length-1];
  const volConfirmed = currentVol > avgVol20 * 1.1;

  const last = candles[candles.length-1];
  const prev = candles[candles.length-2];
  const body = Math.abs(last.close - last.open);
  const wick = (last.high - last.low) || 0.0001;
  const strongGreen = last.close > last.open && body/wick > 0.6;
  const strongRed   = last.close < last.open && body/wick > 0.6;
  const momentum    = last.close - prev.close;

  return {
    symbol, price, ema5, ema8, ema13, ema21, ema50, ema200,
    rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
    volConfirmed, strongGreen, strongRed, momentum,
  };
}

// ─── Decision Engine — Buy A-D + Sell E-G ────────────────────────────────────
function runDecisionEngine(d) {
  const { price, ema5, ema8, ema13, ema21, ema50, ema200,
          rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
          volConfirmed, strongGreen, strongRed, momentum } = d;

  // ── Ribbon ──
  const ribbonBull = ema5>ema8 && ema8>ema13 && ema13>ema21 && ema21>ema50;
  const ribbonBear = ema5<ema8 && ema8<ema13 && ema13<ema21 && ema21<ema50;
  const emaStackBull = ema8>ema21 && ema21>ema50 && price>ema8;
  const emaStackBear = ema8<ema21 && ema21<ema50 && price<ema8;

  // ── Price zones ──
  const goldenZone = price>ema50 && price>ema200;
  const nearEMA200 = price>ema200 && price<=ema200*1.02;
  const aboveVWAP  = vwapVal && price>vwapVal;
  const belowVWAP  = vwapVal && price<vwapVal;

  // ── RSI ──
  const rsiOversold  = rsi14!==null && rsi14<35;
  const rsiExtreme   = rsi3!==null  && rsi3<20;
  const rsiOverbought     = rsi14!==null && rsi14>65;
  const rsiExtremeOverbought = rsi3!==null && rsi3>80;

  // ── StochRSI ──
  const stochOversold   = stochRSI?.oversold  ?? false;
  const stochOverbought = stochRSI?.overbought ?? false;

  // ── MACD ──
  const macdBull      = macdData && macdData.macdLine>macdData.signalLine;
  const macdBear      = macdData && macdData.macdLine<macdData.signalLine;
  const macdCrossUp   = macdData && macdData.histogram>0;
  const macdCrossDown = macdData && macdData.histogram<0;

  // ── Bollinger Bands ──
  const nearBBLower = bb && price<=bb.lower*1.005;
  const nearBBUpper = bb && price>=bb.upper*0.995;

  // ── Momentum ──
  const posMom = momentum>0;
  const negMom = momentum<0;

  const reasons = [];

  // ════ BUY SETS ════

  // A — Classic Trend Pullback (CoinsKid + TA Analyst)
  const setA = ribbonBull && goldenZone && rsiOversold && macdBull && volConfirmed;
  if (setA) reasons.push("✅ A-TrendPullback: ribbon bull + golden zone + RSI<35 + MACD bull + volume");

  // B — Momentum Breakout (Crypto Kirby)
  const setB = emaStackBull && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  if (setB) reasons.push("✅ B-RibbonBreakout: EMA stack + strong green + MACD cross up + above VWAP + volume");

  // C — Bollinger Band Lower Bounce (TA Analyst)
  const setC = nearBBLower && rsiExtreme && (stochOversold||rsiOversold) && emaStackBull && posMom;
  if (setC) reasons.push("✅ C-BBBounce: BB lower + RSI3<20 + StochRSI oversold + EMA stack + momentum");

  // D — EMA200 Major Support (Benjamin Cowen)
  const setD = nearEMA200 && rsiOversold && macdBull && volConfirmed;
  if (setD) reasons.push("✅ D-EMA200Support: near EMA200 + RSI oversold + MACD bull + volume");

  // ════ SELL SETS ════

  // E — Full Trend Break (exit on ribbon breakdown)
  const setE = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed;
  if (setE) reasons.push("✅ E-TrendBreak: ribbon bear + MACD bear + below VWAP + below EMA21 + volume");

  // F — Overbought Exhaustion at BB Upper
  const setF = rsiExtremeOverbought && nearBBUpper && (stochOverbought||rsiOverbought) && macdCrossDown && negMom;
  if (setF) reasons.push("✅ F-Exhaustion: RSI3>80 + BB upper + StochRSI overbought + MACD cross down");

  // G — Momentum Breakdown (fast exit)
  const setG = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;
  if (setG) reasons.push("✅ G-Breakdown: strong red + below EMA21+EMA50 + MACD bear + below VWAP");

  const buySignal  = setA||setB||setC||setD;
  const sellSignal = setE||setF||setG;

  let signal     = null;
  let triggerSet = null;

  if (buySignal && !sellSignal) {
    signal     = "BUY";
    triggerSet = setA?"A-TrendPullback": setB?"B-Breakout": setC?"C-BBBounce":"D-EMA200";
  } else if (sellSignal && !buySignal) {
    signal     = "SELL";
    triggerSet = setE?"E-TrendBreak": setF?"F-Exhaustion":"G-Breakdown";
  }

  if (!reasons.length) reasons.push("🚫 No set passed — market neutral, waiting");

  return {
    signal, triggerSet, allPass: !!signal, reasons,
    details: { setA,setB,setC,setD, setE,setF,setG, ribbonBull,ribbonBear,goldenZone },
  };
}

// ─── TP/SL Exit Checker ───────────────────────────────────────────────────────
async function checkExits(exchange, symbol, price) {
  const all       = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others    = all.filter(p => p.symbol !== symbol);
  const remaining = [];

  for (const pos of positions) {
    const pnlPct  = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct  / 100);
    const hitTP   = price >= tpPrice;
    const hitSL   = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
      const icon   = hitTP ? "✅" : "🛑";
      console.log(`   ${icon} ${symbol} ${reason} | Entry:${fmtPrice(pos.entryPrice)} → ${fmtPrice(price)} | P&L:${pnlPct.toFixed(2)}%`);

      if (!CONFIG.paperTrading) {
        try {
          const ccxtSym = symbol.replace("USDT","/USDT");
          await exchange.createMarketSellOrder(ccxtSym, pos.sizeUSD/price);
          console.log(`   ✅ Exit order placed`);
        } catch (err) {
          console.log(`   ❌ Exit failed: ${err.message}`);
          remaining.push(pos);
          continue;
        }
      } else {
        console.log(`   📋 PAPER EXIT — $${pos.sizeUSD.toFixed(2)} @ ${fmtPrice(price)}`);
      }

      writeCsvRow({
        timestamp: new Date().toISOString(), symbol, price,
        tradeSize: pos.sizeUSD, allPass: true,
        paperTrading: CONFIG.paperTrading, orderPlaced: true,
        orderId: `EXIT-${Date.now()}`, side: "SELL",
        notes: reason, triggerSet: reason,
      });
    } else {
      const pnlIcon = pnlPct >= 0 ? "📈" : "📉";
      console.log(`   ⏳ ${symbol} ${pnlIcon} ${pnlPct.toFixed(2)}% | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(slPrice)}`);
      remaining.push(pos);
    }
  }
  savePositions([...others, ...remaining]);
}

// ─── Morning Brief ────────────────────────────────────────────────────────────
async function morningBrief() {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        TradeBotIQ v3.2 — MORNING BRIEF                   ║");
  console.log(`║        ${new Date().toUTCString().padEnd(51)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  const results = [];
  for (const symbol of CONFIG.assets) {
    try {
      const d   = await analyzeAsset(symbol);
      const res = runDecisionEngine(d);
      const trend = res.details.ribbonBull ? "📈 BULL" : res.details.ribbonBear ? "📉 BEAR" : "↔️  FLAT";
      const zone  = res.details.goldenZone ? "🟢" : "🔴";
      const sig   = res.signal ? `🔔 ${res.signal}(${res.triggerSet})` : "⚪ WAIT";
      console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | ${trend} | ${zone} | RSI14:${d.rsi14?.toFixed(1).padStart(5)} | StochK:${d.stochRSI?.k.toFixed(1).padStart(5)} | ${sig}`);
      res.reasons.forEach(r => console.log(`     → ${r}`));
      results.push({ symbol, price: d.price, signal: res.signal, triggerSet: res.triggerSet, reasons: res.reasons });
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  ${symbol.padEnd(10)} ❌ ${err.message}`);
    }
  }

  const buys  = results.filter(r => r.signal === "BUY");
  const sells = results.filter(r => r.signal === "SELL");
  console.log("\n── Signals ───────────────────────────────────────────────");
  console.log(`  🟢 BUY:  ${buys.length  ? buys.map(r=>r.symbol).join(", ")  : "None"}`);
  console.log(`  🔴 SELL: ${sells.length ? sells.map(r=>r.symbol).join(", ") : "None"}`);
  console.log(`  ⚪ WAIT: ${CONFIG.assets.length - buys.length - sells.length} assets`);

  writeFileSync(BRIEF_FILE, JSON.stringify({ timestamp: new Date().toISOString(), assets: results }, null, 2));
  console.log(`\n  Brief saved → ${BRIEF_FILE}\n`);
}

// ─── PineScript Export (full) ─────────────────────────────────────────────────
function exportPineScript() {
  const pine = `//@version=5
strategy("TradeBotIQ v3.2 — Expert Hybrid", overlay=true,
         default_qty_type=strategy.percent_of_equity, default_qty_value=1)

// ── EMA Ribbon ─────────────────────────────────────────────
ema5   = ta.ema(close, 5)
ema8   = ta.ema(close, 8)
ema13  = ta.ema(close, 13)
ema21  = ta.ema(close, 21)
ema50  = ta.ema(close, 50)
ema200 = ta.ema(close, 200)

plot(ema5,   color=color.new(color.lime,0),   linewidth=1, title="EMA5")
plot(ema8,   color=color.new(color.green,0),  linewidth=1, title="EMA8")
plot(ema13,  color=color.new(color.teal,0),   linewidth=1, title="EMA13")
plot(ema21,  color=color.new(color.blue,0),   linewidth=2, title="EMA21")
plot(ema50,  color=color.new(color.orange,0), linewidth=2, title="EMA50")
plot(ema200, color=color.new(color.red,0),    linewidth=3, title="EMA200")

// ── Indicators ─────────────────────────────────────────────
rsi3  = ta.rsi(close, 3)
rsi14 = ta.rsi(close, 14)
[macdLine, signalLine, hist] = ta.macd(close, 12, 26, 9)
[bbUpper, bbMid, bbLower] = ta.bb(close, 20, 2)
vwapVal = ta.vwap(hlc3)
stochK = ta.stoch(rsi14, rsi14, rsi14, 14)
volAvg = ta.sma(volume, 20)

// ── Derived ────────────────────────────────────────────────
volOk       = volume > volAvg * 1.1
ribbonBull  = ema5>ema8 and ema8>ema13 and ema13>ema21 and ema21>ema50
ribbonBear  = ema5<ema8 and ema8<ema13 and ema13<ema21 and ema21<ema50
goldenZone  = close>ema50 and close>ema200
body        = math.abs(close-open)
wick        = math.max(high-low, 0.0001)
strongGreen = close>open and body/wick>0.6
strongRed   = close<open and body/wick>0.6

// ── BUY Sets ───────────────────────────────────────────────
setA = ribbonBull and goldenZone and rsi14<35 and macdLine>signalLine and volOk
setB = ema8>ema21 and ema21>ema50 and close>ema8 and strongGreen and hist>0 and close>vwapVal and volOk
setC = close<=bbLower*1.005 and rsi3<20 and rsi14<35 and ema8>ema21 and close>close[1]
setD = close>ema200 and close<=ema200*1.02 and rsi14<35 and macdLine>signalLine and volOk

// ── SELL Sets ──────────────────────────────────────────────
setE = ribbonBear and macdLine<signalLine and close<vwapVal and close<ema21 and volOk
setF = rsi3>80 and close>=bbUpper*0.995 and rsi14>65 and hist<0 and close<close[1]
setG = strongRed and close<ema21 and close<ema50 and macdLine<signalLine and close<vwapVal

buySignal  = (setA or setB or setC or setD) and not (setE or setF or setG)
sellSignal = (setE or setF or setG) and not (setA or setB or setC or setD)

// ── Execution ──────────────────────────────────────────────
if (buySignal)
    strategy.entry("Long", strategy.long)
    strategy.exit("TP/SL", "Long",
        profit = close * 0.035 / syminfo.mintick,
        loss   = close * 0.010 / syminfo.mintick)

if (sellSignal)
    strategy.close("Long", comment="Sell Signal")

// ── Visuals ────────────────────────────────────────────────
plotshape(buySignal,  title="BUY",  location=location.belowbar, color=color.green, style=shape.labelup,   text="BUY")
plotshape(sellSignal, title="SELL", location=location.abovebar, color=color.red,   style=shape.labeldown, text="SELL")
bgcolor(goldenZone ? color.new(color.green,95) : color.new(color.red,95))

// ── Alerts ─────────────────────────────────────────────────
alertcondition(buySignal,  "TradeBotIQ BUY",  "TradeBotIQ BUY: {{ticker}} @ {{close}}")
alertcondition(sellSignal, "TradeBotIQ SELL", "TradeBotIQ SELL: {{ticker}} @ {{close}}")
`;
  writeFileSync("TradeBotIQ.pine", pine);
  console.log("✅ PineScript saved → TradeBotIQ.pine");
  console.log("   Open TradingView → Pine Editor → paste → Add to Chart");
}

// ─── Run Single Asset (FULL execution restored) ───────────────────────────────
async function runAsset(exchange, symbol, log) {
  try {
    const d   = await analyzeAsset(symbol);
    const res = runDecisionEngine(d);
    const { signal, triggerSet, allPass, reasons, details } = res;

    const tradeSize   = Math.min(CONFIG.portfolioValue * (CONFIG.riskPerTrade/100), CONFIG.maxTradeSize);
    const count       = countTodaysTrades(log, symbol);
    const withinLimit = count < CONFIG.maxTradesPerDay;

    console.log(`\n── ${symbol} ${fmtPrice(d.price)} ───────────────────────────────────`);
    console.log(`   Ribbon: ${details.ribbonBull?"📈 BULL":"📉 BEAR"} | Zone: ${details.goldenZone?"🟢 Golden":"🔴 Bear"}`);
    console.log(`   RSI14:${d.rsi14?.toFixed(1)} | RSI3:${d.rsi3?.toFixed(1)} | StochK:${d.stochRSI?.k.toFixed(1)||"N/A"}`);
    console.log(`   MACD: ${d.macdData?.macdLine>d.macdData?.signalLine?"🟢 Bull":"🔴 Bear"} | Vol:${d.volConfirmed?"✅":"⚠️ Low"}`);
    if (d.bb) console.log(`   BB: [${fmtPrice(d.bb.lower)} ↔ ${fmtPrice(d.bb.upper)}]`);
    console.log(`   BUY  A:${details.setA?"✅":"🚫"} B:${details.setB?"✅":"🚫"} C:${details.setC?"✅":"🚫"} D:${details.setD?"✅":"🚫"}`);
    console.log(`   SELL E:${details.setE?"✅":"🚫"} F:${details.setF?"✅":"🚫"} G:${details.setG?"✅":"🚫"}`);
    reasons.forEach(r => console.log(`   ${r}`));

    // Check TP/SL exits first
    await checkExits(exchange, symbol, d.price);

    const logEntry = {
      timestamp: new Date().toISOString(), symbol,
      price: d.price, tradeSize, signal, triggerSet, allPass,
      orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading,
      indicators: { ema8:d.ema8, ema21:d.ema21, ema50:d.ema50, ema200:d.ema200, rsi3:d.rsi3, rsi14:d.rsi14 },
      conditions: [{ label: triggerSet||"none", pass: allPass }],
    };

    if (!withinLimit) {
      console.log(`   🚫 Trade limit reached (${count}/${CONFIG.maxTradesPerDay})`);
    } else if (!allPass || !signal) {
      console.log(`   ⚪ No signal — waiting for setup`);
    } else {
      console.log(`   ✅ ${signal} — Set ${triggerSet} | Size: $${tradeSize.toFixed(2)}`);

      if (CONFIG.paperTrading) {
        logEntry.orderPlaced = true;
        logEntry.orderId     = `PAPER-${Date.now()}`;
        logEntry.side        = signal;
        logEntry.notes       = `Paper ${signal} via ${triggerSet}`;
        console.log(`   📋 PAPER ${signal} — $${tradeSize.toFixed(2)} of ${symbol} @ ${fmtPrice(d.price)}`);
      } else {
        console.log(`   🔴 LIVE ${signal} — $${tradeSize.toFixed(2)} of ${symbol}`);
        try {
          const ccxtSym = symbol.replace("USDT","/USDT");
          const qty     = tradeSize / d.price;
          const order   = signal === "BUY"
            ? await exchange.createMarketBuyOrder(ccxtSym, qty)
            : await exchange.createMarketSellOrder(ccxtSym, qty);
          logEntry.orderPlaced = true;
          logEntry.orderId     = order.id;
          logEntry.side        = signal;
          logEntry.notes       = `Live ${signal} via ${triggerSet}`;
          console.log(`   ✅ Order placed — ID: ${order.id}`);
        } catch (err) {
          console.log(`   ❌ Order failed: ${err.message}`);
          logEntry.notes = `Failed: ${err.message}`;
        }
      }

      // Track open position for TP/SL
      if (logEntry.orderPlaced && signal === "BUY") {
        const positions = loadPositions();
        positions.push({ symbol, entryPrice: d.price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
        savePositions(positions);
      }
    }

    log.trades.push(logEntry);
    writeCsvRow({ ...logEntry, notes: logEntry.notes||(allPass?`${signal} via ${triggerSet}`:"No signal") });

  } catch (err) {
    console.log(`\n── ${symbol} ❌ Error: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();

  if (process.argv.includes("--brief")) { await morningBrief(); return; }
  if (process.argv.includes("--pine"))  { exportPineScript();   return; }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v3.2 — Multi-Asset Expert Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:    ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | ${IS_LIVE?"🔴 LIVE Binance":"🧪 DEMO Testnet"}`);
  console.log(`  Assets:  ${CONFIG.assets.join(", ")}`);
  console.log(`  Toggle:  TRADING_ACCOUNT=${TRADING_ACCOUNT} | PAPER_TRADING=${CONFIG.paperTrading}`);
  console.log("═══════════════════════════════════════════════════════════");

  const exchange = createExchange();
  const log      = loadLog();

  for (const symbol of CONFIG.assets) {
    await runAsset(exchange, symbol, log);
    await new Promise(r => setTimeout(r, 400));
  }

  saveLog(log);
  console.log(`\n✅ All ${CONFIG.assets.length} assets checked | Log → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err.message); process.exit(1); });
