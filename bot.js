/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Cloud mode: runs on Railway on a schedule. Pulls candle data direct from
 * Binance (free, no auth), calculates all indicators, runs safety check,
 * executes via Binance if everything lines up.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BINANCE_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env") && !process.env.BINANCE_API_KEY) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Binance credentials",
        "BINANCE_API_KEY=",
        "BINANCE_PRIVATE_KEY_PATH=/app/private_key.pem",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=500",
        "MAX_TRADE_SIZE_USD=35",
        "MAX_TRADES_PER_DAY=31",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "TIMEFRAME=2H",
      ].join("\n") + "\n",
    );
    try {
      console.log("Please set credentials as Railway environment variables.");
    } catch {}
    console.log(
      "Fill in your Binance credentials as Railway environment variables\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      console.log("Please set credentials as Railway environment variables.");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  // Always print the CSV location so users know where to find their trade log
  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "2H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "500"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "35"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "31"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.0"),
  binance: {
    apiKey: process.env.BINANCE_API_KEY,
    privateKeyPath: process.env.BINANCE_PRIVATE_KEY_PATH || "/app/private_key.pem",
    baseUrl: "https://api.binance.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const POSITIONS_FILE = "positions.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}


// ─── Position Tracking & Exit Logic ─────────────────────────────────────────

function loadPositions() {
  if (!existsSync(POSITIONS_FILE)) return [];
  return JSON.parse(readFileSync(POSITIONS_FILE, "utf8"));
}

function savePositions(positions) {
  writeFileSync(POSITIONS_FILE, JSON.stringify(positions, null, 2));
}

async function checkAndClosePositions(price) {
  const positions = loadPositions();
  if (positions.length === 0) return;

  console.log("\n── Checking Open Positions ─────────────────────────────\n");

  const remaining = [];

  for (const pos of positions) {
    const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlUSD = (pnlPct / 100) * pos.sizeUSD;
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct / 100);

    console.log(`  Position: ${pos.symbol} | Entry: ${pos.entryPrice.toFixed(2)} | Now: ${price.toFixed(2)}`);
    console.log(`  P&L: ${pnlPct.toFixed(2)}% (${pnlUSD.toFixed(4)}) | TP: ${tpPrice.toFixed(2)} | SL: ${slPrice.toFixed(2)}`);

    const hitTP = price >= tpPrice;
    const hitSL = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP
        ? `✅ TAKE PROFIT hit (+${CONFIG.takeProfitPct}%)`
        : `🛑 STOP LOSS hit (-${CONFIG.stopLossPct}%)`;
      console.log(`  ${reason} — closing position`);

      if (!CONFIG.paperTrading) {
        try {
          await placeBinanceOrder(pos.symbol, "sell", pos.sizeUSD, price);
          console.log(`  ✅ Sell order placed on Bitget`);
        } catch (err) {
          console.log(`  ❌ Sell order failed: ${err.message}`);
          remaining.push(pos);
          continue;
        }
      } else {
        console.log(`  📋 PAPER SELL — would sell ${pos.symbol} ~${pos.sizeUSD.toFixed(2)} at ${price.toFixed(2)}`);
      }

      writeTradeCsv({
        timestamp: new Date().toISOString(),
        symbol: pos.symbol,
        price,
        tradeSize: pos.sizeUSD,
        allPass: true,
        paperTrading: CONFIG.paperTrading,
        orderPlaced: true,
        orderId: `EXIT-${Date.now()}`,
        conditions: [],
        side: "SELL",
        pnlPct: pnlPct.toFixed(2),
        exitReason: hitTP ? "TAKE_PROFIT" : "STOP_LOSS",
      });
    } else {
      console.log(`  ⏳ Holding — TP not reached yet (need +${CONFIG.takeProfitPct}%) | SL at ${slPrice.toFixed(2)}`);
      remaining.push(pos);
    }
  }

  savePositions(remaining);
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Map our timeframe format to Binance interval format
  const intervalMap = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1H": "1h",
    "2H": "2h",
    "3H": "3h",
    "4H": "4h",
    "1D": "1d",
    "1W": "1w",
  };
  const binanceInterval = intervalMap[interval] || "1m";

  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${binanceInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
  const data = await res.json();

  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — session-based, resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules) {
  const results = [];
  let signal = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Decision Engine ──────────────────────────────────────\n");

  // ── Trend Detection (3 EMAs must agree) ──
  const strongUptrend  = ema8 > ema21 && ema21 > ema50 && price > ema8;
  const strongDowntrend = ema8 < ema21 && ema21 < ema50 && price < ema8;
  const aboveVWAP = price > vwap;
  const belowVWAP = price < vwap;

  // ── Scoring system — more factors = higher confidence ──
  let buyScore  = 0;
  let sellScore = 0;

  if (strongUptrend)   buyScore  += 3;  // EMAs stacked bullish
  if (aboveVWAP)       buyScore  += 2;  // price above VWAP
  if (rsi3 < 30)       buyScore  += 3;  // RSI oversold snap-back
  if (strongGreen)     buyScore  += 1;  // strong green candle
  if (volumeConfirmed) buyScore  += 1;  // volume confirms move
  if (momentum > 0)    buyScore  += 1;  // positive momentum

  if (strongDowntrend) sellScore += 3;  // EMAs stacked bearish
  if (belowVWAP)       sellScore += 2;  // price below VWAP
  if (rsi3 > 70)       sellScore += 3;  // RSI overbought snap-back
  if (strongRed)       sellScore += 1;  // strong red candle
  if (volumeConfirmed) sellScore += 1;  // volume confirms move
  if (momentum < 0)    sellScore += 1;  // negative momentum

  const MIN_SCORE = 6; // out of 11 — high confidence required

  console.log(`  Buy Score:  ${buyScore}/11`);
  console.log(`  Sell Score: ${sellScore}/11`);
  console.log(`  Min Required: ${MIN_SCORE}/11\n`);

  if (buyScore >= MIN_SCORE && buyScore > sellScore) {
    signal = "BUY";
    console.log("  Bias: STRONG BUY SIGNAL 🟢\n");
    check("EMA stack bullish (8 > 21 > 50)", "true", String(strongUptrend), strongUptrend);
    check("Price above VWAP", `> ${vwap.toFixed(2)}`, price.toFixed(2), aboveVWAP);
    check("RSI(3) oversold snap-back", "< 30", rsi3.toFixed(2), rsi3 < 30);
    check("Volume above 20-bar average", "> avg x1.1", volumeConfirmed ? "Yes" : "No", volumeConfirmed);
    check("Positive momentum", "> 0", momentum.toFixed(2), momentum > 0);
    check("Strong green candle", "true", String(strongGreen), strongGreen);

  } else if (sellScore >= MIN_SCORE && sellScore > buyScore) {
    signal = "SELL";
    console.log("  Bias: STRONG SELL SIGNAL 🔴\n");
    check("EMA stack bearish (8 < 21 < 50)", "true", String(strongDowntrend), strongDowntrend);
    check("Price below VWAP", `< ${vwap.toFixed(2)}`, price.toFixed(2), belowVWAP);
    check("RSI(3) overbought snap-back", "> 70", rsi3.toFixed(2), rsi3 > 70);
    check("Volume above 20-bar average", "> avg x1.1", volumeConfirmed ? "Yes" : "No", volumeConfirmed);
    check("Negative momentum", "< 0", momentum.toFixed(2), momentum < 0);
    check("Strong red candle", "true", String(strongRed), strongRed);

  } else {
    signal = null;
    console.log(`  Bias: NEUTRAL — score too low (Buy:${buyScore} Sell:${sellScore} Min:${MIN_SCORE}). No trade.\n`);
    results.push({ label: "Minimum confidence score", required: `>= ${MIN_SCORE}`, actual: `B:${buyScore} S:${sellScore}`, pass: false });
  }

  const allPass = results.length > 0 && results.every(r => r.pass);
  return { results, allPass, signal };
}


// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Binance Execution ──────────────────────────────────────────────────────

import { createPrivateKey, sign } from "crypto";

function signBinance(queryString) {
  const privateKeyPem = process.env.BINANCE_PRIVATE_KEY || readFileSync(CONFIG.binance.privateKeyPath, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(queryString), privateKey);
  return signature.toString("base64url");
}

async function placeBinanceOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(5);
  const timestamp = Date.now();

  // Binance spot uses BTC not BTCUSDT for quantity
  const params = [
    `symbol=${symbol}`,
    `side=${side.toUpperCase()}`,
    `type=MARKET`,
    `quantity=${quantity}`,
    `timestamp=${timestamp}`,
  ].join("&");

  const signature = signBinance(params);
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${params}&signature=${signature}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": CONFIG.binance.apiKey,
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance order failed: ${data.msg}`);
  }

  return { orderId: data.orderId, fills: data.fills };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.side === "SELL" ? `PAPER-EXIT(${logEntry.exitReason})` : "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.side === "SELL" ? `LIVE-EXIT(${logEntry.exitReason})` : "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);

  // Volume confirmation — is current volume above 20-candle average?
  const volumes = candles.map(c => c.volume);
  const avgVol20 = volumes.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const currentVol = volumes[volumes.length - 1];
  const volumeConfirmed = currentVol > avgVol20 * 1.1;

  // Candle momentum — is last candle green or red?
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const greenCandle = lastCandle.close > lastCandle.open;
  const redCandle = lastCandle.close < lastCandle.open;
  const strongGreen = greenCandle && (lastCandle.close - lastCandle.open) > (lastCandle.high - lastCandle.low) * 0.6;
  const strongRed = redCandle && (lastCandle.open - lastCandle.close) > (lastCandle.high - lastCandle.low) * 0.6;

  // Momentum — is price moving in right direction vs previous candle?
  const momentum = lastCandle.close - prevCandle.close;
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  ${ema8.toFixed(2)}`);
  console.log(`  EMA(21): ${ema21.toFixed(2)}`);
  console.log(`  EMA(50): ${ema50.toFixed(2)}`);
  console.log(`  Volume:  ${currentVol.toFixed(2)} (avg: ${avgVol20.toFixed(2)}) ${volumeConfirmed ? '✅ Above avg' : '⚠️ Below avg'}`);
  console.log(`  Candle:  ${strongGreen ? '🟢 Strong Green' : strongRed ? '🔴 Strong Red' : greenCandle ? '🟡 Weak Green' : '🟡 Weak Red'}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Check and close existing positions first
  await checkAndClosePositions(price);

  // Run safety check
  const { results, allPass, signal } = runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      const paperPositions = loadPositions();
      paperPositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
      savePositions(paperPositions);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBinanceOrder(
          CONFIG.symbol,
          signal.toLowerCase(),
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        const livePositions = loadPositions();
        livePositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
        savePositions(livePositions);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}// ─── Binance Execution ──────────────────────────────────────────────────────

import { createPrivateKey, sign } from "crypto";

function signBinance(queryString) {
  const privateKeyPem = process.env.BINANCE_PRIVATE_KEY || readFileSync(CONFIG.binance.privateKeyPath, "utf8");
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(queryString), privateKey);
  return signature.toString("base64url");
}

async function placeBinanceOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(5);
  const timestamp = Date.now();

  // Binance spot uses BTC not BTCUSDT for quantity
  const params = [
    `symbol=${symbol}`,
    `side=${side.toUpperCase()}`,
    `type=MARKET`,
    `quantity=${quantity}`,
    `timestamp=${timestamp}`,
  ].join("&");

  const signature = signBinance(params);
  const url = `${CONFIG.binance.baseUrl}/api/v3/order?${params}&signature=${signature}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-MBX-APIKEY": CONFIG.binance.apiKey,
    },
  });

  const data = await res.json();
  if (data.code && data.code < 0) {
    throw new Error(`Binance order failed: ${data.msg}`);
  }

  return { orderId: data.orderId, fills: data.fills };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.side === "SELL" ? `PAPER-EXIT(${logEntry.exitReason})` : "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = logEntry.side === "SELL" ? `LIVE-EXIT(${logEntry.exitReason})` : "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data — need enough for EMA(8) + full session for VWAP
  console.log("\n── Fetching market data from Binance ───────────────────\n");
  const candles = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);

  // Volume confirmation — is current volume above 20-candle average?
  const volumes = candles.map(c => c.volume);
  const avgVol20 = volumes.slice(-20).reduce((a,b) => a+b, 0) / 20;
  const currentVol = volumes[volumes.length - 1];
  const volumeConfirmed = currentVol > avgVol20 * 1.1;

  // Candle momentum — is last candle green or red?
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const greenCandle = lastCandle.close > lastCandle.open;
  const redCandle = lastCandle.close < lastCandle.open;
  const strongGreen = greenCandle && (lastCandle.close - lastCandle.open) > (lastCandle.high - lastCandle.low) * 0.6;
  const strongRed = redCandle && (lastCandle.open - lastCandle.close) > (lastCandle.high - lastCandle.low) * 0.6;

  // Momentum — is price moving in right direction vs previous candle?
  const momentum = lastCandle.close - prevCandle.close;
  const vwap = calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  ${ema8.toFixed(2)}`);
  console.log(`  EMA(21): ${ema21.toFixed(2)}`);
  console.log(`  EMA(50): ${ema50.toFixed(2)}`);
  console.log(`  Volume:  ${currentVol.toFixed(2)} (avg: ${avgVol20.toFixed(2)}) ${volumeConfirmed ? '✅ Above avg' : '⚠️ Below avg'}`);
  console.log(`  Candle:  ${strongGreen ? '🟢 Strong Green' : strongRed ? '🔴 Strong Red' : greenCandle ? '🟡 Weak Green' : '🟡 Weak Red'}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Check and close existing positions first
  await checkAndClosePositions(price);

  // Run safety check
  const { results, allPass, signal } = runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      const paperPositions = loadPositions();
      paperPositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
      savePositions(paperPositions);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`,
      );
      try {
        const order = await placeBinanceOrder(
          CONFIG.symbol,
          signal.toLowerCase(),
          tradeSize,
          price,
        );
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        const livePositions = loadPositions();
        livePositions.push({ symbol: CONFIG.symbol, entryPrice: price, sizeUSD: tradeSize, timestamp: new Date().toISOString() });
        savePositions(livePositions);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
