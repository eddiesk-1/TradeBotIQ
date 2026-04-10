import { readFileSync, writeFileSync } from 'fs';
let code = readFileSync('bot.js', 'utf8');

// 1. Add EMA21 and volume calculations in main run()
code = code.replace(
  '  const ema8 = calcEMA(closes, 8);',
  `  const ema8 = calcEMA(closes, 8);
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
  const momentum = lastCandle.close - prevCandle.close;`
);

// 2. Pass new indicators into safety check
code = code.replace(
  'const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);',
  'const { results, allPass, signal } = runSafetyCheck(price, ema8, ema21, ema50, vwap, rsi3, volumeConfirmed, strongGreen, strongRed, momentum, rules);'
);

// 3. Log new indicators
code = code.replace(
  '  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);',
  `  console.log(\`  EMA(8):  \$\${ema8.toFixed(2)}\`);
  console.log(\`  EMA(21): \$\${ema21.toFixed(2)}\`);
  console.log(\`  EMA(50): \$\${ema50.toFixed(2)}\`);
  console.log(\`  Volume:  \${currentVol.toFixed(2)} (avg: \${avgVol20.toFixed(2)}) \${volumeConfirmed ? '✅ Above avg' : '⚠️ Below avg'}\`);
  console.log(\`  Candle:  \${strongGreen ? '🟢 Strong Green' : strongRed ? '🔴 Strong Red' : greenCandle ? '🟡 Weak Green' : '🟡 Weak Red'}\`);`
);

// 4. Replace the entire runSafetyCheck function with improved version
const oldFn = code.indexOf('function runSafetyCheck(price, ema8, vwap, rsi3, rules)');
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

  console.log("\\n── Decision Engine ──────────────────────────────────────\\n");

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

  const MIN_SCORE = 7; // out of 11 — high confidence required

  console.log(\`  Buy Score:  \${buyScore}/11\`);
  console.log(\`  Sell Score: \${sellScore}/11\`);
  console.log(\`  Min Required: \${MIN_SCORE}/11\\n\`);

  if (buyScore >= MIN_SCORE && buyScore > sellScore) {
    signal = "BUY";
    console.log("  Bias: STRONG BUY SIGNAL 🟢\\n");
    check("EMA stack bullish (8 > 21 > 50)", "true", String(strongUptrend), strongUptrend);
    check("Price above VWAP", \`> \${vwap.toFixed(2)}\`, price.toFixed(2), aboveVWAP);
    check("RSI(3) oversold snap-back", "< 30", rsi3.toFixed(2), rsi3 < 30);
    check("Volume above 20-bar average", "> avg x1.1", volumeConfirmed ? "Yes" : "No", volumeConfirmed);
    check("Positive momentum", "> 0", momentum.toFixed(2), momentum > 0);
    check("Strong green candle", "true", String(strongGreen), strongGreen);

  } else if (sellScore >= MIN_SCORE && sellScore > buyScore) {
    signal = "SELL";
    console.log("  Bias: STRONG SELL SIGNAL 🔴\\n");
    check("EMA stack bearish (8 < 21 < 50)", "true", String(strongDowntrend), strongDowntrend);
    check("Price below VWAP", \`< \${vwap.toFixed(2)}\`, price.toFixed(2), belowVWAP);
    check("RSI(3) overbought snap-back", "> 70", rsi3.toFixed(2), rsi3 > 70);
    check("Volume above 20-bar average", "> avg x1.1", volumeConfirmed ? "Yes" : "No", volumeConfirmed);
    check("Negative momentum", "< 0", momentum.toFixed(2), momentum < 0);
    check("Strong red candle", "true", String(strongRed), strongRed);

  } else {
    signal = null;
    console.log(\`  Bias: NEUTRAL — score too low (Buy:\${buyScore} Sell:\${sellScore} Min:\${MIN_SCORE}). No trade.\\n\`);
    results.push({ label: "Minimum confidence score", required: \`>= \${MIN_SCORE}\`, actual: \`B:\${buyScore} S:\${sellScore}\`, pass: false });
  }

  const allPass = results.length > 0 && results.every(r => r.pass);
  return { results, allPass, signal };
}

`;

code = code.slice(0, oldFn) + newFn + code.slice(endOfFn);

// 5. Use signal (BUY/SELL) in the order placement
code = code.replace(
  "console.log(`\\n📋 PAPER TRADE — would buy ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);",
  "console.log(`\\n📋 PAPER TRADE — would ${signal} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);"
);

code = code.replace(
  'console.log(`\\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} BUY ${CONFIG.symbol}`);',
  'console.log(`\\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${signal} ${CONFIG.symbol}`);'
);

code = code.replace(
  'const order = await placeBitGetOrder(\n          CONFIG.symbol,\n          "buy",',
  'const order = await placeBitGetOrder(\n          CONFIG.symbol,\n          signal.toLowerCase(),'
);

writeFileSync('bot.js', code);
console.log('✅ Decision engine upgraded — EMA triple stack + volume + momentum + scoring system');
