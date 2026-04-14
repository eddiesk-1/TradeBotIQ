/**
 * TradeBotIQ v4.2
 * + Ed25519 signing (Binance asymmetric keys)
 * + Max drawdown protection (-15% hard stop)
 * + ATR volatility filter (score penalty + trade size scaling)
 * + Equity-based risk scaling
 * + All v4.1 features intact
 */

import "dotenv/config";
import ccxt from "ccxt";
import { createPrivateKey, sign } from "crypto";
import { writeFileSync, existsSync, appendFileSync, readFileSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const TRADING_ACCOUNT = (process.env.TRADING_ACCOUNT || "demo").toLowerCase();
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const IS_LIVE         = TRADING_ACCOUNT === "live" && !PAPER_TRADING;

const CONFIG = {
  assets:          (process.env.ASSETS || "BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,LINKUSDT,PEPEUSDT").split(","),
  timeframe:       (process.env.TIMEFRAME || "1H").toLowerCase(),
  takeProfitPct:   parseFloat(process.env.TAKE_PROFIT_PCT  || "3.5"),
  stopLossPct:     parseFloat(process.env.STOP_LOSS_PCT    || "1.0"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "31"),
  s1Pct:           parseFloat(process.env.S1_PCT           || "30"),
  s2Pct:           parseFloat(process.env.S2_PCT           || "5"),
  maxTradeUSD:     parseFloat(process.env.MAX_TRADE_SIZE_USD|| "35"),
  minScoreS1:      parseInt(process.env.MIN_SCORE_S1       || "65"),
  minScoreS2:      parseInt(process.env.MIN_SCORE_S2       || "45"),
  maxDrawdown:     parseFloat(process.env.MAX_DRAWDOWN_PCT  || "15"),
  paperTrading:    PAPER_TRADING,
  isLive:          IS_LIVE,
  feeRate:         0.001,
  slippagePct:     0.0005,
};

// ─── Ed25519 Exchange Setup ───────────────────────────────────────────────────
function createExchange() {
  const apiKey = IS_LIVE
    ? process.env.BINANCE_API_KEY
    : process.env.BINANCE_DEMO_API_KEY;

  const privateKeyPem = process.env.BINANCE_PRIVATE_KEY;

  const ex = new ccxt.binance({
    apiKey,
    enableRateLimit: true,
    options: { defaultType: "spot", adjustForTimeDifference: true },
  });

  // Inject Ed25519 signing — overrides default HMAC
    // Improved Ed25519 signing for ccxt compatibility
    // Improved Ed25519 signing for ccxt compatibility
    if (privateKeyPem && !CONFIG.paperTrading) {
      ex.sign = async function (path, api, method, params, headers, body) {
        const timestamp = Date.now();
        const query = { ...params, timestamp };
        const queryString = Object.entries(query)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join("&");

        const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
        const signature = sign(null, Buffer.from(queryString), privateKey).toString("base64url");

        query.signature = signature;
        const finalQuery = Object.entries(query)
          .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
          .join("&");

        return {
          url: `${this.urls.api.public}${path}?${finalQuery}`,
          method,
          body: "",
          headers: {
            "X-MBX-APIKEY": apiKey,
            "Content-Type": "application/json"
          }
        };
      };
      console.log("🔐 Ed25519 signing active (improved)");
    }
  }
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
  const rv = [];
  for (let i = 14; i <= closes.length; i++) rv.push(calcRSI(closes.slice(0,i), 14));
  const recent = rv.slice(-14);
  const minR = Math.min(...recent), maxR = Math.max(...recent);
  const rawK = maxR === minR ? 50 : ((rv[rv.length-1] - minR) / (maxR - minR)) * 100;
  return { k: rawK, oversold: rawK < 20, overbought: rawK > 80 };
}
function calcMACD(closes) {
  if (closes.length < 35) return null;
  const mv = [];
  for (let i = 26; i <= closes.length; i++) {
    const sl = closes.slice(0,i);
    mv.push(calcEMA(sl,12) - calcEMA(sl,26));
  }
  const macdLine = mv[mv.length-1];
  const signalLine = calcEMA(mv, 9);
  return { macdLine, signalLine, histogram: macdLine - signalLine };
}
function calcBB(closes) {
  if (closes.length < 20) return null;
  const slice = closes.slice(-20);
  const sma = slice.reduce((a,b)=>a+b,0) / 20;
  const std = Math.sqrt(slice.reduce((s,c) => s + Math.pow(c-sma,2), 0) / 20);
  return { upper: sma+2*std, middle: sma, lower: sma-2*std };
}
function calcVWAP(candles) {
  const midnight = new Date(); midnight.setUTCHours(0,0,0,0);
  const sess = candles.filter(c => c.time >= midnight.getTime());
  if (!sess.length) return null;
  const tpv = sess.reduce((s,c) => s + ((c.high+c.low+c.close)/3)*c.volume, 0);
  const vol  = sess.reduce((s,c) => s + c.volume, 0);
  return vol ? tpv/vol : null;
}
function calcCMF(candles, period = 20) {
  if (candles.length < period) return null;
  const recent = candles.slice(-period);
  const mfv = recent.map(c => {
    const hl = c.high - c.low;
    return hl === 0 ? 0 : ((c.close-c.low) - (c.high-c.close)) / hl * c.volume;
  });
  const sumMFV = mfv.reduce((a,b) => a+b, 0);
  const sumVol = recent.reduce((s,c) => s + c.volume, 0);
  return sumVol ? sumMFV / sumVol : 0;
}
function calcRSIDivergence(closes, period = 14, lookback = 5) {
  if (closes.length < period + lookback + 2) return { bullish: false, bearish: false };
  const rsiNow  = calcRSI(closes, period);
  const rsiPrev = calcRSI(closes.slice(0, -lookback), period);
  const pNow    = closes[closes.length-1];
  const pPrev   = closes[closes.length-1-lookback];
  return { bullish: pNow < pPrev && rsiNow > rsiPrev, bearish: pNow > pPrev && rsiNow < rsiPrev };
}
function calcTDSequential(closes) {
  if (closes.length < 10) return { count:0, setup:null, upCount:0, downCount:0 };
  let up = 0, dn = 0;
  for (let i = closes.length - 1; i >= 4; i--) {
    if      (closes[i] > closes[i-4]) { if (dn === 0) up++; else break; }
    else if (closes[i] < closes[i-4]) { if (up === 0) dn++; else break; }
    else break;
  }
  return { count: Math.max(up,dn), setup: up>=9?"SELL_9":dn>=9?"BUY_9":null, upCount:up, downCount:dn };
}
function calcFibLevels(closes, lookback = 50) {
  if (closes.length < lookback) return null;
  const recent = closes.slice(-lookback);
  const high = Math.max(...recent), low = Math.min(...recent);
  const range = high - low;
  const price = closes[closes.length-1];
  return {
    high, low,
    fib618: high - range*0.618, fib50: high - range*0.5,
    nearFib618: Math.abs(price-(high-range*0.618))/(high-range*0.618) < 0.015,
    nearFib50:  Math.abs(price-(high-range*0.5))  /(high-range*0.5)   < 0.015,
  };
}
// ATR — volatility measure
function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(-period-1).map((c,i,arr) => {
    if (i === 0) return c.high - c.low;
    return Math.max(c.high-c.low, Math.abs(c.high-arr[i-1].close), Math.abs(c.low-arr[i-1].close));
  });
  return trs.slice(1).reduce((a,b)=>a+b,0) / period;
}

// ─── Asset Analysis ───────────────────────────────────────────────────────────
async function analyzeAsset(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${CONFIG.timeframe}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${symbol}: ${res.status}`);
  const candles = (await res.json()).map(k => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
  const closes = candles.map(c => c.close);
  const price  = closes[closes.length-1];

  const ema5=calcEMA(closes,5); const ema8=calcEMA(closes,8); const ema13=calcEMA(closes,13);
  const ema21=calcEMA(closes,21); const ema50=calcEMA(closes,50); const ema200=calcEMA(closes,200);
  const rsi3=calcRSI(closes,3); const rsi14=calcRSI(closes,14);
  const stochRSI=calcStochRSI(closes); const macdData=calcMACD(closes);
  const bb=calcBB(closes); const vwapVal=calcVWAP(candles);
  const cmf=calcCMF(candles); const rsiDiv=calcRSIDivergence(closes);
  const tdSeq=calcTDSequential(closes); const fib=calcFibLevels(closes);
  const atr=calcATR(candles);
  const atrPct = atr ? (atr / price) * 100 : 0;

  const vols = candles.map(c => c.volume);
  const avgVol20   = vols.slice(-20).reduce((a,b)=>a+b,0) / 20;
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
    cmf, rsiDiv, tdSeq, fib, atr, atrPct,
    volConfirmed, strongGreen, strongRed, momentum,
  };
}

// ─── AI Score Engine ──────────────────────────────────────────────────────────
function calcAIScore(d, ob, m5, direction) {
  let score = 0;
  const isBuy = direction === "BUY";

  if (isBuy)  { if (d.rsi14 < 35) score += 20; else if (d.rsi14 < 50) score += 10; }
  else        { if (d.rsi14 > 65) score += 20; else if (d.rsi14 > 50) score += 10; }

  if (isBuy)  { if (d.cmf > 0.05) score += 20; else if (d.cmf > 0) score += 10; }
  else        { if (d.cmf < -0.05) score += 20; else if (d.cmf < 0) score += 10; }

  if (isBuy  && d.rsiDiv?.bullish) score += 15;
  if (!isBuy && d.rsiDiv?.bearish) score += 15;

  if (isBuy  && d.tdSeq?.setup === "BUY_9")  score += 15;
  if (!isBuy && d.tdSeq?.setup === "SELL_9") score += 15;

  if (d.volConfirmed) score += 10;

  if (ob) {
    if (isBuy  && ob.bullish)        score += 15;
    else if (isBuy && ob.imbalance > 1.0) score += 7;
    if (!isBuy && ob.bearish)        score += 15;
    else if (!isBuy && ob.imbalance < 1.0) score += 7;
    if (ob.spread > 0.1) score -= 5;
  }

  if (m5) {
    if (isBuy  && m5.bullish) score += 10;
    if (!isBuy && m5.bearish) score += 10;
    if (m5.volSpike) score += 5;
  }

  if (isBuy && d.fib?.nearFib618) score += 5;

  // ATR penalty — high volatility = lower confidence
  if (d.atrPct > 3.0) score -= 15;
  else if (d.atrPct > 2.0) score -= 8;
  else if (d.atrPct > 1.5) score -= 3;

  return Math.max(0, Math.min(100, score));
}

// ─── Trade Size (ATR + Equity Scaling) ───────────────────────────────────────
function calcTradeSize(balance, pct, equityScaler, atrPct) {
  let size = balance * (pct / 100) * equityScaler;

  // Reduce size in high volatility
  if (atrPct > 3.0)      size *= 0.5;
  else if (atrPct > 2.0) size *= 0.7;
  else if (atrPct > 1.5) size *= 0.85;

  return Math.min(size, CONFIG.maxTradeUSD);
}

// ─── Strategy #1 ──────────────────────────────────────────────────────────────
function runStrategy1(d) {
  const { price, ema5, ema8, ema13, ema21, ema50, ema200,
          rsi3, rsi14, stochRSI, macdData, bb, vwap: vwapVal,
          cmf, rsiDiv, tdSeq, fib, volConfirmed, strongGreen, strongRed, momentum } = d;

  const ribbonBull = ema5>ema8 && ema8>ema13 && ema13>ema21 && ema21>ema50;
  const ribbonBear = ema5<ema8 && ema8<ema13 && ema13<ema21 && ema21<ema50;
  const goldenZone = price>ema50 && price>ema200;
  const nearEMA200 = price>ema200 && price<=ema200*1.02;
  const aboveVWAP  = vwapVal && price>vwapVal;
  const belowVWAP  = vwapVal && price<vwapVal;
  const macdBull   = macdData?.macdLine > macdData?.signalLine;
  const macdBear   = macdData?.macdLine < macdData?.signalLine;
  const macdCrossUp   = macdData?.histogram > 0;
  const macdCrossDown = macdData?.histogram < 0;
  const nearBBLower = bb && price<=bb.lower*1.005;
  const nearBBUpper = bb && price>=bb.upper*0.995;
  const cmfBull = cmf !== null && cmf > 0.05;
  const cmfBear = cmf !== null && cmf < -0.05;
  const posMom = momentum > 0, negMom = momentum < 0;
  const stochOS = stochRSI?.oversold ?? false;
  const stochOB = stochRSI?.overbought ?? false;
  const reasons = [];

  const setA     = ribbonBull && goldenZone && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setB     = (ema8>ema21&&ema21>ema50) && strongGreen && macdCrossUp && aboveVWAP && posMom && volConfirmed;
  const setC     = nearBBLower && rsi3<20 && (stochOS||rsi14<35) && (ema8>ema21) && posMom;
  const setD     = nearEMA200 && rsi14<35 && macdBull && volConfirmed && cmfBull;
  const setE_buy = fib?.nearFib618 && ribbonBull && goldenZone && rsi14<50 && (cmfBull||macdBull) && posMom;
  const setF_buy = rsiDiv?.bullish && cmfBull && macdBull && (ema8>ema21) && volConfirmed;
  const setG     = ribbonBear && macdBear && belowVWAP && price<ema21 && volConfirmed && cmfBear;
  const setH     = rsi3>80 && nearBBUpper && (stochOB||rsi14>65) && macdCrossDown && negMom;
  const setI     = (tdSeq?.setup==="SELL_9"||rsiDiv?.bearish) && cmfBear && macdBear && price<ema21;
  const setJ     = strongRed && price<ema21 && price<ema50 && macdBear && negMom && belowVWAP;

  if (setA)     reasons.push("✅ S1-A: Ribbon+Zone+RSI<35+MACD+Vol+CMF");
  if (setB)     reasons.push("✅ S1-B: EMA+StrongGreen+MACDx+VWAP+Vol");
  if (setC)     reasons.push("✅ S1-C: BBLow+RSI3<20+StochOS+Mom");
  if (setD)     reasons.push("✅ S1-D: EMA200+RSI<35+MACD+CMF");
  if (setE_buy) reasons.push("✅ S1-E: Fib618+Ribbon+confirm (vanDePoppe)");
  if (setF_buy) reasons.push("✅ S1-F: RSI bullDiv+CMF+MACD (ToneVays)");
  if (setG)     reasons.push("✅ S1-G[SELL]: Ribbon bear+MACD+VWAP+CMF");
  if (setH)     reasons.push("✅ S1-H[SELL]: RSI3>80+BBUp+StochOB+MACD");
  if (setI)     reasons.push(`✅ S1-I[SELL]: ${tdSeq?.setup==="SELL_9"?"TDSeq9":"bearDiv"}+CMF+MACD`);
  if (setJ)     reasons.push("✅ S1-J[SELL]: StrongRed+EMA+MACD+VWAP");

  const buySignal  = setA||setB||setC||setD||setE_buy||setF_buy;
  const sellSignal = setG||setH||setI||setJ;
  let signal = null, triggerSet = null;
  if (buySignal && !sellSignal)  { signal="BUY";  triggerSet=setA?"S1-A":setB?"S1-B":setC?"S1-C":setD?"S1-D":setE_buy?"S1-E":"S1-F"; }
  else if (sellSignal && !buySignal) { signal="SELL"; triggerSet=setG?"S1-G":setH?"S1-H":setI?"S1-I":"S1-J"; }
  if (!reasons.length) reasons.push("🚫 S1: No set passed");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S1",
    details:{ setA,setB,setC,setD,setE_buy,setF_buy,setG,setH,setI,setJ,
              ribbonBull,ribbonBear,goldenZone,macdBull,macdBear,cmfBull,cmfBear } };
}

// ─── Strategy #2 ──────────────────────────────────────────────────────────────
function runStrategy2(d) {
  const { price, ema8, ema21, ema50, rsi14, macdData, bb, vwap: vwapVal,
          cmf, rsiDiv, tdSeq, fib, volConfirmed, strongRed, momentum } = d;

  const emaStackBull = ema8>ema21 && ema21>ema50;
  const emaStackBear = ema8<ema21 && ema21<ema50;
  const aboveVWAP    = vwapVal && price>vwapVal;
  const belowVWAP    = vwapVal && price<vwapVal;
  const macdBull     = macdData?.macdLine > macdData?.signalLine;
  const macdBear     = macdData?.macdLine < macdData?.signalLine;
  const nearBBLower  = bb && price<=bb.lower*1.02;
  const nearBBUpper  = bb && price>=bb.upper*0.98;
  const cmfPos = cmf !== null && cmf > 0;
  const cmfNeg = cmf !== null && cmf < 0;
  const posMom = momentum > 0, negMom = momentum < 0;
  const reasons = [];

  const setA2 = emaStackBull && rsi14<55 && (macdBull||cmfPos) && aboveVWAP;
  const setB2 = (fib?.nearFib618||fib?.nearFib50) && emaStackBull && rsi14<60 && posMom;
  const setC2 = nearBBLower && rsi14<45 && posMom && (emaStackBull||price>ema50);
  const setD2 = rsiDiv?.bullish && (emaStackBull||price>ema50) && posMom;
  const setE2 = tdSeq?.setup==="BUY_9" && (macdBull||cmfPos);
  const setF2 = emaStackBear && (macdBear||cmfNeg) && belowVWAP;
  const setG2 = nearBBUpper && rsi14>60 && negMom;
  const setH2 = (rsiDiv?.bearish||tdSeq?.setup==="SELL_9") && (macdBear||cmfNeg);

  if (setA2) reasons.push("✅ S2-A: EMA+RSI<55+MACD/CMF+VWAP");
  if (setB2) reasons.push("✅ S2-B: Fib50/618+EMA+Mom");
  if (setC2) reasons.push("✅ S2-C: BBLow+RSI<45+Mom");
  if (setD2) reasons.push("✅ S2-D: RSI bullDiv+Trend+Mom");
  if (setE2) reasons.push("✅ S2-E: TDSeq BUY_9");
  if (setF2) reasons.push("✅ S2-F[SELL]: EMA bear+MACD/CMF+VWAP");
  if (setG2) reasons.push("✅ S2-G[SELL]: BBUp+RSI>60+Mom-");
  if (setH2) reasons.push("✅ S2-H[SELL]: bearDiv/TDSeq9");

  const buySignal  = setA2||setB2||setC2||setD2||setE2;
  const sellSignal = setF2||setG2||setH2;
  let signal = null, triggerSet = null;
  if (buySignal && !sellSignal)      { signal="BUY";  triggerSet=setA2?"S2-A":setB2?"S2-B":setC2?"S2-C":setD2?"S2-D":"S2-E"; }
  else if (sellSignal && !buySignal) { signal="SELL"; triggerSet=setF2?"S2-F":setG2?"S2-G":"S2-H"; }
  if (!reasons.length) reasons.push("⚪ S2: No signal");

  return { signal, triggerSet, allPass:!!signal, reasons, strategy:"S2",
    details:{ setA2,setB2,setC2,setD2,setE2,setF2,setG2,setH2 } };
}

// ─── TP/SL Exit ───────────────────────────────────────────────────────────────
async function checkExits(exchange, symbol, price, botState) {
  const all       = loadPositions();
  const positions = all.filter(p => p.symbol === symbol);
  const others    = all.filter(p => p.symbol !== symbol);
  const remaining = [];

  for (const pos of positions) {
    const tpPrice = pos.entryPrice * (1 + CONFIG.takeProfitPct / 100);
    const slPrice = pos.entryPrice * (1 - CONFIG.stopLossPct  / 100);
    const hitTP   = price >= tpPrice;
    const hitSL   = price <= slPrice;

    if (hitTP || hitSL) {
      const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
      const pnl    = calcRealPnL(pos, price);
      updateStats(pos.strategy||"S1", pnl, botState);
      console.log(`   ${hitTP?"✅":"🛑"} [${pos.strategy}] ${symbol} ${reason} | Net:$${pnl.net.toFixed(3)} Fees:$${pnl.fees.toFixed(3)}`);

      if (!CONFIG.paperTrading) {
        try {
          await exchange.createMarketSellOrder(symbol.replace("USDT","/USDT"), pos.sizeUSD/price);
        } catch (err) { console.log(`   ❌ Exit failed: ${err.message}`); remaining.push(pos); continue; }
      } else {
        console.log(`   📋 PAPER EXIT — Net P&L: $${pnl.net.toFixed(3)}`);
      }
      writeCsvRow({
        timestamp: new Date().toISOString(), symbol, price,
        tradeSize: pos.sizeUSD, allPass: true, paperTrading: CONFIG.paperTrading,
        orderPlaced: true, orderId: `EXIT-${Date.now()}`, side: "SELL",
        notes: reason, triggerSet: reason, strategy: pos.strategy||"S1",
        realPnL: pnl.net, score: 0, atrPct: 0,
      });
    } else {
      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      console.log(`   ⏳ [${pos.strategy}] ${symbol} ${pnlPct>=0?"📈":"📉"}${pnlPct.toFixed(2)}% | TP:${fmtPrice(tpPrice)} SL:${fmtPrice(slPrice)}`);
      remaining.push(pos);
    }
  }
  savePositions([...others, ...remaining]);
}

// ─── Place Order ──────────────────────────────────────────────────────────────
async function placeOrder(exchange, symbol, signal, tradeSize, price, logEntry) {
  const slip = CONFIG.paperTrading ? 0 : price * CONFIG.slippagePct * (signal==="BUY"?1:-1);
  const execPrice = price + slip;

  if (CONFIG.paperTrading) {
    logEntry.orderPlaced = true;
    logEntry.orderId     = `PAPER-${Date.now()}`;
    logEntry.side        = signal;
    logEntry.notes       = `Paper ${signal} Score:${logEntry.score} ATR:${logEntry.atrPct?.toFixed(2)}% via ${logEntry.triggerSet}`;
    console.log(`   📋 PAPER ${signal} $${tradeSize.toFixed(2)} @ ${fmtPrice(execPrice)} Score:${logEntry.score} ATR:${logEntry.atrPct?.toFixed(2)}%`);
  } else {
    try {
      const ccxtSym = symbol.replace("USDT","/USDT");
      const qty     = tradeSize / execPrice;
      const order   = signal === "BUY"
        ? await exchange.createMarketBuyOrder(ccxtSym, qty)
        : await exchange.createMarketSellOrder(ccxtSym, qty);
      logEntry.orderPlaced = true;
      logEntry.orderId     = order.id;
      logEntry.side        = signal;
      logEntry.notes       = `Live ${signal} Score:${logEntry.score} ATR:${logEntry.atrPct?.toFixed(2)}% via ${logEntry.triggerSet}`;
      console.log(`   ✅ LIVE ${signal} ID:${order.id} Score:${logEntry.score}`);
    } catch (err) {
      console.log(`   ❌ Order failed: ${err.message}`);
      logEntry.notes = `Failed: ${err.message}`;
    }
  }
  if (logEntry.orderPlaced && signal === "BUY") {
    const positions = loadPositions();
    positions.push({ symbol, entryPrice: price, sizeUSD: tradeSize, strategy: logEntry.strategy, timestamp: new Date().toISOString() });
    savePositions(positions);
  }
}

// ─── Morning Brief ────────────────────────────────────────────────────────────
async function morningBrief() {
  const botState = loadState();
  const alloc    = getOptimizedAllocation(botState);
  const bh       = loadBalanceHistory();
  const balance  = bh.lastBalance || 0;
  const dd       = checkDrawdown(balance);

  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║        TradeBotIQ v4.2 — MORNING BRIEF                   ║");
  console.log(`║        ${new Date().toUTCString().padEnd(51)}║`);
  console.log("╚═══════════════════════════════════════════════════════════╝\n");
  console.log(`  Balance: $${balance.toFixed(2)} | Drawdown: ${dd.drawdownPct?.toFixed(1)||0}% | Guard: ${dd.ok?"🟢 OK":`🛑 BREACHED (-${CONFIG.maxDrawdown}%)`}`);
  console.log(`  S1 WR:${alloc.wr1!==null?(alloc.wr1*100).toFixed(0)+"%":"new"} (${alloc.s1Pct.toFixed(0)}%) | S2 WR:${alloc.wr2!==null?(alloc.wr2*100).toFixed(0)+"%":"new"} (${alloc.s2Pct.toFixed(0)}%)`);
  console.log(`  PnL: S1=$${(botState.totalPnL?.S1||0).toFixed(2)} S2=$${(botState.totalPnL?.S2||0).toFixed(2)} | Fees: $${(botState.totalFees||0).toFixed(2)}\n`);

  for (const symbol of CONFIG.assets) {
    try {
      const d  = await analyzeAsset(symbol);
      const r1 = runStrategy1(d);
      const r2 = runStrategy2(d);
      const [ob, m5] = await Promise.all([fetchOrderBook(symbol), get5mConfirmation(symbol)]);
      const sc1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
      const sc2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;
      const trend = r1.details.ribbonBull?"📈 BULL":r1.details.ribbonBear?"📉 BEAR":"↔️  FLAT";
      const zone  = r1.details.goldenZone?"🟢":"🔴";
      const atrStr = `ATR:${d.atrPct?.toFixed(2)||"N/A"}%${d.atrPct>2?"⚠️":""}`;
      const obStr  = ob ? `OB:${ob.imbalance.toFixed(2)}${ob.bullish?"🟢":ob.bearish?"🔴":""}` : "";
      console.log(`  ${symbol.padEnd(10)} ${fmtPrice(d.price).padStart(14)} | ${trend} | ${zone} | RSI:${d.rsi14?.toFixed(1)} | CMF:${d.cmf?.toFixed(3)} | ${atrStr} | ${obStr}`);
      const s1Str = r1.signal && sc1>=CONFIG.minScoreS1 ? `🔔${r1.signal}(${r1.triggerSet})Sc:${sc1}` : r1.signal ? `⚠️ Sc:${sc1}<${CONFIG.minScoreS1}` : "⚪";
      const s2Str = r2.signal && sc2>=CONFIG.minScoreS2 ? `🔔${r2.signal}(${r2.triggerSet})Sc:${sc2}` : "⚪";
      console.log(`    S1:${s1Str} | S2:${s2Str}`);
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`  ${symbol} ❌ ${err.message}`);
    }
  }
  writeFileSync(BRIEF_FILE, JSON.stringify({ timestamp: new Date().toISOString() }, null, 2));
  console.log(`\n  Brief saved → ${BRIEF_FILE}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  initFiles();
  if (process.argv.includes("--brief")) { await morningBrief(); return; }

  const botState     = loadState();
  const alloc        = getOptimizedAllocation(botState);
  const exchange     = createExchange();
  const balance      = await fetchBalance(exchange);
  const equityScaler = getEquityScaler(balance);
  const bh           = loadBalanceHistory();
  const prevBal      = bh.history.length > 1 ? bh.history[bh.history.length-2]?.balance : balance;
  const balDiff      = balance - prevBal;

  // ── Drawdown guard ──
  const dd = checkDrawdown(balance);
  if (!dd.ok) {
    console.log(`\n🛑 MAX DRAWDOWN BREACHED — Trading paused`);
    console.log(`   Balance: $${balance.toFixed(2)} | Initial: $${dd.initialBalance?.toFixed(2)} | Drawdown: ${dd.drawdownPct?.toFixed(1)}% (max -${CONFIG.maxDrawdown}%)`);
    console.log(`   To resume: set TRADING_ACCOUNT=demo or reset balance-history.json\n`);
    return;
  }

  const s1WR = alloc.wr1!==null ? `${(alloc.wr1*100).toFixed(0)}%` : "new";
  const s2WR = alloc.wr2!==null ? `${(alloc.wr2*100).toFixed(0)}%` : "new";

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  TradeBotIQ v4.2 — Ed25519 + ATR + Drawdown Guard");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode:       ${CONFIG.paperTrading?"📋 PAPER":"🔴 LIVE"} | ${IS_LIVE?"🔴 LIVE Binance":"🧪 DEMO"}`);
  console.log(`  Balance:    $${balance.toFixed(2)} ${balDiff>=0?`📈+$${balDiff.toFixed(2)}`:`📉-$${Math.abs(balDiff).toFixed(2)}`}`);
  console.log(`  Drawdown:   ${dd.drawdownPct?.toFixed(1)||0}% | Limit: -${CONFIG.maxDrawdown}% 🟢 OK`);
  console.log(`  EquityScale:${equityScaler.toFixed(2)}x | S1 WR:${s1WR}(${alloc.s1Pct.toFixed(0)}%) S2 WR:${s2WR}(${alloc.s2Pct.toFixed(0)}%)`);
  console.log(`  PnL:        S1=$${(botState.totalPnL?.S1||0).toFixed(2)} S2=$${(botState.totalPnL?.S2||0).toFixed(2)} | Fees: $${(botState.totalFees||0).toFixed(2)}`);
  console.log(`  Signing:    ${process.env.BINANCE_PRIVATE_KEY ? "🔐 Ed25519":"🔑 HMAC"}`);
  console.log(`  Assets:     ${CONFIG.assets.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  if (!CONFIG.paperTrading) saveBalance(balance);

  const log = loadLog();

  for (const symbol of CONFIG.assets) {
    try {
      const d  = await analyzeAsset(symbol);
      const r1 = runStrategy1(d);
      const r2 = runStrategy2(d);
      const [ob, m5] = await Promise.all([fetchOrderBook(symbol), get5mConfirmation(symbol)]);
      const sc1 = r1.signal ? calcAIScore(d, ob, m5, r1.signal) : 0;
      const sc2 = r2.signal ? calcAIScore(d, ob, m5, r2.signal) : 0;

      console.log(`\n── ${symbol} ${fmtPrice(d.price)} ─────────────────────────────────────`);
      console.log(`   Ribbon:${r1.details.ribbonBull?"📈":"📉"} Zone:${r1.details.goldenZone?"🟢":"🔴"} CMF:${d.cmf?.toFixed(3)} TD:${d.tdSeq.count}${d.tdSeq.upCount>0?"↑":"↓"} ATR:${d.atrPct?.toFixed(2)}%${d.atrPct>2?"⚠️ HIGH":""}`);
      console.log(`   RSI14:${d.rsi14?.toFixed(1)} RSI3:${d.rsi3?.toFixed(1)} MACD:${r1.details.macdBull?"🟢":"🔴"} Vol:${d.volConfirmed?"✅":"⚠️"}`);
      if (ob) {
        let color = "⚪";
        let label = "Neutral";
        if (ob.bullish) { color = "🟢"; label = "Buy wall"; }
        else if (ob.bearish) { color = "🔴"; label = "Sell pressure"; }
        console.log(`   OB: Imb:${ob.imbalance.toFixed(3)} ${color} ${label} Spread:${ob.spread.toFixed(4)}%`);
      }
      if (m5) {
        const m5Trend = m5.bullish ? "📈" : m5.bearish ? "📉" : "↔️";
        console.log(`   5m: ${m5Trend} RSI5m:${m5.rsi5m?.toFixed(1)} Spike:${m5.volSpike?"✅":"🚫"}`);
      }
      if (d.fib) console.log(`   Fib618:${fmtPrice(d.fib.fib618)} Near:${d.fib.nearFib618?"✅":"🚫"} | Div Bull:${d.rsiDiv.bullish?"✅":"🚫"} Bear:${d.rsiDiv.bearish?"✅":"🚫"}`);

      await checkExits(exchange, symbol, d.price, botState);

      // ── S1 ──
      const s1Count = countTodaysTrades(log, symbol, "S1");
      r1.reasons.forEach(r => console.log(`   ${r}`));
      if (r1.allPass && r1.signal && s1Count < CONFIG.maxTradesPerDay) {
        if (sc1 >= CONFIG.minScoreS1) {
          const ts1 = calcTradeSize(balance, alloc.s1Pct, equityScaler, d.atrPct);
          console.log(`   🎯 S1 ${r1.signal} | Score:${sc1} ATR:${d.atrPct?.toFixed(2)}% Size:$${ts1.toFixed(2)}`);
          const e1 = { timestamp: new Date().toISOString(), symbol, price: d.price, tradeSize: ts1, signal: r1.signal, triggerSet: r1.triggerSet, allPass: true, orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading, strategy: "S1", score: sc1, atrPct: d.atrPct, conditions: [{ label: r1.triggerSet, pass: true }] };
          await placeOrder(exchange, symbol, r1.signal, ts1, d.price, e1);
          log.trades.push(e1);
          writeCsvRow({ ...e1, notes: e1.notes||`S1 ${r1.signal} via ${r1.triggerSet}` });
        } else {
          console.log(`   ⚠️ S1 signal but score ${sc1}<${CONFIG.minScoreS1} — skipped`);
        }
      } else if (!r1.allPass) {
        console.log(`   ⚪ S1: No signal`);
      }

      // ── S2 ──
      const s2Count = countTodaysTrades(log, symbol, "S2");
      r2.reasons.forEach(r => console.log(`   ${r}`));
      if (r2.allPass && r2.signal && s2Count < CONFIG.maxTradesPerDay) {
        if (sc2 >= CONFIG.minScoreS2) {
          const ts2 = calcTradeSize(balance, alloc.s2Pct, equityScaler, d.atrPct) * 0.5;
          console.log(`   🎯 S2 ${r2.signal} | Score:${sc2} ATR:${d.atrPct?.toFixed(2)}% Size:$${ts2.toFixed(2)}`);
          const e2 = { timestamp: new Date().toISOString(), symbol, price: d.price, tradeSize: ts2, signal: r2.signal, triggerSet: r2.triggerSet, allPass: true, orderPlaced: false, orderId: null, paperTrading: CONFIG.paperTrading, strategy: "S2", score: sc2, atrPct: d.atrPct, conditions: [{ label: r2.triggerSet, pass: true }] };
          await placeOrder(exchange, symbol, r2.signal, ts2, d.price, e2);
          log.trades.push(e2);
          writeCsvRow({ ...e2, notes: e2.notes||`S2 ${r2.signal} via ${r2.triggerSet}` });
        } else {
          console.log(`   ⚪ S2 signal score ${sc2}<${CONFIG.minScoreS2} — skipped`);
        }
      } else if (!r2.allPass) {
        console.log(`   ⚪ S2: No signal`);
      }

    } catch (err) {
      console.log(`\n── ${symbol} ❌ ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  saveLog(log);
  saveState(botState);
  console.log(`\n✅ Done | $${balance.toFixed(2)} | S1:${s1WR} S2:${s2WR} | Drawdown:${dd.drawdownPct?.toFixed(1)||0}%`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

run().catch(err => { console.error("Bot error:", err.message); process.exit(1); });
