import { readFileSync, writeFileSync } from 'fs';
let code = readFileSync('bot.js', 'utf8');

const oldFn = code.indexOf('function runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules)');
const endOfFn = code.indexOf('\n// ─── Trade Limits', oldFn);

const newFn = `function runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules) {
  const results = [];
  let signal = null;

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(\`  \${icon} \${label}\`);
    console.log(\`     Required: \${required} | Actual: \${actual}\`);
  };

  // ── Pre-calculate all conditions ──
  const emaStackBull  = ema8 > ema21 && ema21 > ema50 && price > ema8;
  const emaStackBear  = ema8 < ema21 && ema21 < ema50 && price < ema8;
  const aboveVWAP     = price > vwap;
  const belowVWAP     = price < vwap;
  const aboveEMA8     = price > ema8;
  const belowEMA8     = price < ema8;
  const rsiOversold   = rsi3 < 30;
  const rsiExtreme    = rsi3 < 20;
  const rsiOverbought = rsi3 > 70;
  const rsiExtremeBear= rsi3 > 80;
  const posMomentum   = momentum > 0;
  const negMomentum   = momentum < 0;

  // ══════════════════════════════════════════════════
  // BUY CONDITION SETS — any one passing = BUY signal
  // ══════════════════════════════════════════════════

  // Set A — Classic Snap-back (high confidence, volume required)
  const setA_buy = emaStackBull && aboveVWAP && rsiOversold && volumeConfirmed;

  // Set B — Momentum Breakout (strong candle + trend confirmation)
  const setB_buy = emaStackBull && aboveVWAP && strongGreen && posMomentum && aboveEMA8;

  // Set C — Extreme Oversold Bounce (RSI<20, no volume needed)
  const setC_buy = rsiExtreme && aboveEMA8 && posMomentum && emaStackBull;

  // ══════════════════════════════════════════════════
  // SELL CONDITION SETS — any one passing = SELL signal
  // ══════════════════════════════════════════════════

  // Set D — Classic Reversal (high confidence, volume required)
  const setD_sell = emaStackBear && belowVWAP && rsiOverbought && volumeConfirmed;

  // Set E — Momentum Breakdown (strong red + trend confirmation)
  const setE_sell = emaStackBear && belowVWAP && strongRed && negMomentum && belowEMA8;

  // Set F — Extreme Overbought Reversal (RSI>80, no volume needed)
  const setF_sell = rsiExtremeBear && belowEMA8 && negMomentum && emaStackBear;

  const buySignal  = setA_buy  || setB_buy  || setC_buy;
  const sellSignal = setD_sell || setE_sell || setF_sell;

  console.log("\\n── Condition Sets ───────────────────────────────────────\\n");

  console.log("  BUY SETS:");
  console.log(\`  Set A (Snap-back + Volume):     \${setA_buy  ? "✅ PASS" : "🚫 fail"} | EMA✓:\${emaStackBull} VWAP✓:\${aboveVWAP} RSI<30:\${rsiOversold} Vol✓:\${volumeConfirmed}\`);
  console.log(\`  Set B (Momentum Breakout):      \${setB_buy  ? "✅ PASS" : "🚫 fail"} | EMA✓:\${emaStackBull} VWAP✓:\${aboveVWAP} StrongGreen:\${strongGreen} Mom+:\${posMomentum}\`);
  console.log(\`  Set C (Extreme Oversold):       \${setC_buy  ? "✅ PASS" : "🚫 fail"} | RSI<20:\${rsiExtreme} EMA8✓:\${aboveEMA8} Mom+:\${posMomentum} EMAstack:\${emaStackBull}\`);

  console.log("\\n  SELL SETS:");
  console.log(\`  Set D (Reversal + Volume):      \${setD_sell ? "✅ PASS" : "🚫 fail"} | EMA✗:\${emaStackBear} VWAP✗:\${belowVWAP} RSI>70:\${rsiOverbought} Vol✓:\${volumeConfirmed}\`);
  console.log(\`  Set E (Momentum Breakdown):     \${setE_sell ? "✅ PASS" : "🚫 fail"} | EMA✗:\${emaStackBear} VWAP✗:\${belowVWAP} StrongRed:\${strongRed} Mom-:\${negMomentum}\`);
  console.log(\`  Set F (Extreme Overbought):     \${setF_sell ? "✅ PASS" : "🚫 fail"} | RSI>80:\${rsiExtremeBear} EMA8✗:\${belowEMA8} Mom-:\${negMomentum} EMAstack:\${emaStackBear}\`);

  console.log("\\n── Decision Engine ──────────────────────────────────────\\n");

  if (buySignal && !sellSignal) {
    signal = "BUY";
    const setName = setA_buy ? "A — Classic Snap-back" : setB_buy ? "B — Momentum Breakout" : "C — Extreme Oversold";
    console.log(\`  Bias: STRONG BUY SIGNAL 🟢 (Set \${setName})\\n\`);
    check("EMA stack bullish (8 > 21 > 50)", "true", String(emaStackBull), emaStackBull);
    check("Price above VWAP", \`> \${vwap.toFixed(2)}\`, price.toFixed(2), aboveVWAP);
    check("RSI(3) oversold", "< 30", rsi3.toFixed(2), rsiOversold);
    check("Positive momentum", "> 0", momentum.toFixed(2), posMomentum);
    check("Strong green candle", "true", String(strongGreen), strongGreen);
    check("Volume confirmed", "yes", volumeConfirmed ? "Yes" : "No", volumeConfirmed);

  } else if (sellSignal && !buySignal) {
    signal = "SELL";
    const setName = setD_sell ? "D — Classic Reversal" : setE_sell ? "E — Momentum Breakdown" : "F — Extreme Overbought";
    console.log(\`  Bias: STRONG SELL SIGNAL 🔴 (Set \${setName})\\n\`);
    check("EMA stack bearish (8 < 21 < 50)", "true", String(emaStackBear), emaStackBear);
    check("Price below VWAP", \`< \${vwap.toFixed(2)}\`, price.toFixed(2), belowVWAP);
    check("RSI(3) overbought", "> 70", rsi3.toFixed(2), rsiOverbought);
    check("Negative momentum", "< 0", momentum.toFixed(2), negMomentum);
    check("Strong red candle", "true", String(strongRed), strongRed);
    check("Volume confirmed", "yes", volumeConfirmed ? "Yes" : "No", volumeConfirmed);

  } else {
    signal = null;
    console.log(\`  Bias: NEUTRAL — no condition set passed. No trade.\\n\`);
    results.push({ label: "No condition set passed", required: "Any set A-F", actual: "All failed", pass: false });
  }

  const allPass = results.length > 0 && results.every(r => r.pass);
  return { results, allPass, signal };
}

`;

code = code.slice(0, oldFn) + newFn + code.slice(endOfFn);
writeFileSync('bot.js', code);
console.log('✅ Multi-condition sets A-F installed');
