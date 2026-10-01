/* One next-minute decision from closed candles. No look-ahead, no random side. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SignalEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SETTINGS = {
    minScore: 70,
    minGap: 12,
    maxDataAgeMs: 90000,
    weights: { trend: 25, momentum: 20, volatility: 10, priceAction: 20, levels: 10, mtf: 15 },
    pairs: {}
  };

  function settingsFor(pair) {
    var extra = SETTINGS.pairs[String(pair || '').toUpperCase()] || {};
    return {
      minScore: extra.minScore != null ? extra.minScore : SETTINGS.minScore,
      minGap: extra.minGap != null ? extra.minGap : SETTINGS.minGap,
      maxDataAgeMs: extra.maxDataAgeMs != null ? extra.maxDataAgeMs : SETTINGS.maxDataAgeMs,
      weights: SETTINGS.weights
    };
  }

  function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  function round(value, digits) {
    if (value == null || !isFinite(value)) return null;
    var p = Math.pow(10, digits || 2);
    return Math.round(value * p) / p;
  }

  function closesOf(rows) {
    var out = [];
    (rows || []).forEach(function (row) {
      if (row && row.close > 0) out.push(row.close);
    });
    return out;
  }

  function ema(values, period) {
    if (!values || values.length < period) return null;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += values[i];
    var prev = sum / period;
    var k = 2 / (period + 1);
    for (var j = period; j < values.length; j++) prev = values[j] * k + prev * (1 - k);
    return prev;
  }

  function rsi(values, period) {
    period = period || 14;
    if (!values || values.length < period + 1) return null;
    var gain = 0;
    var loss = 0;
    for (var i = 1; i <= period; i++) {
      var diff = values[i] - values[i - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    var avgGain = gain / period;
    var avgLoss = loss / period;
    for (var j = period + 1; j < values.length; j++) {
      var step = values[j] - values[j - 1];
      avgGain = (avgGain * (period - 1) + (step > 0 ? step : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (step < 0 ? -step : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  function emaSeries(values, period) {
    var out = [];
    if (!values || values.length < period) return out;
    var sum = 0;
    for (var i = 0; i < period; i++) sum += values[i];
    var prev = sum / period;
    var k = 2 / (period + 1);
    for (var j = period; j < values.length; j++) {
      prev = values[j] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  function macd(values) {
    if (!values || values.length < 40) return null;
    var fast = emaSeries(values, 12);
    var slow = emaSeries(values, 26);
    var line = [];
    var shared = Math.min(fast.length, slow.length);
    for (var i = 0; i < shared; i++) line.push(fast[fast.length - shared + i] - slow[slow.length - shared + i]);
    if (line.length < 10) return null;
    var signal = emaSeries(line, 9);
    if (!signal.length) return null;
    var macdNow = line[line.length - 1];
    var prev = line[line.length - 2];
    var sig = signal[signal.length - 1];
    return { macd: macdNow, signal: sig, hist: macdNow - sig, prev: prev };
  }

  function adx(rows, period) {
    period = period || 14;
    if (!rows || rows.length < period * 2 + 2) return { adx: null, plusDI: null, minusDI: null };
    var tr = [];
    var plus = [];
    var minus = [];
    for (var i = 1; i < rows.length; i++) {
      var upMove = rows[i].high - rows[i - 1].high;
      var downMove = rows[i - 1].low - rows[i].low;
      plus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minus.push(downMove > upMove && downMove > 0 ? downMove : 0);
      tr.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - rows[i - 1].close), Math.abs(rows[i].low - rows[i - 1].close)));
    }
    var atr = 0;
    var sp = 0;
    var sm = 0;
    for (var n = 0; n < period; n++) {
      atr += tr[n];
      sp += plus[n];
      sm += minus[n];
    }
    var dx = [];
    var pdi = 0;
    var mdi = 0;
    for (var j = period; j < tr.length; j++) {
      atr = atr - atr / period + tr[j];
      sp = sp - sp / period + plus[j];
      sm = sm - sm / period + minus[j];
      pdi = atr ? 100 * sp / atr : 0;
      mdi = atr ? 100 * sm / atr : 0;
      var den = pdi + mdi;
      dx.push(den ? 100 * Math.abs(pdi - mdi) / den : 0);
    }
    if (dx.length < period) return { adx: null, plusDI: pdi, minusDI: mdi };
    var value = 0;
    for (var k = 0; k < period; k++) value += dx[k];
    value /= period;
    for (var q = period; q < dx.length; q++) value = (value * (period - 1) + dx[q]) / period;
    return { adx: value, plusDI: pdi, minusDI: mdi };
  }

  function atrPack(rows, period) {
    period = period || 14;
    if (!rows || rows.length < period + 2) return { atr: null, recent: null, base: null, ratio: null };
    var tr = [];
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1].close;
      tr.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - prev), Math.abs(rows[i].low - prev)));
    }
    var value = 0;
    for (var n = 0; n < period; n++) value += tr[n];
    value /= period;
    for (var j = period; j < tr.length; j++) value = (value * (period - 1) + tr[j]) / period;
    function avg(list) {
      if (!list.length) return 0;
      return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
    }
    var recent = avg(tr.slice(-5));
    var base = avg(tr.slice(-30));
    return { atr: value, recent: recent, base: base, ratio: base ? recent / base : null };
  }

  function bollinger(values) {
    if (!values || values.length < 20) return null;
    var slice = values.slice(-20);
    var mean = slice.reduce(function (a, b) { return a + b; }, 0) / 20;
    var variance = slice.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / 20;
    var sd = Math.sqrt(variance);
    return { mid: mean, upper: mean + 2 * sd, lower: mean - 2 * sd };
  }

  function stochastic(rows) {
    if (!rows || rows.length < 16) return null;
    var kValues = [];
    for (var i = 13; i < rows.length; i++) {
      var hi = -Infinity;
      var lo = Infinity;
      for (var j = i - 13; j <= i; j++) {
        hi = Math.max(hi, rows[j].high);
        lo = Math.min(lo, rows[j].low);
      }
      var span = hi - lo;
      kValues.push(span ? 100 * (rows[i].close - lo) / span : 50);
    }
    var k = kValues[kValues.length - 1];
    var dSlice = kValues.slice(-3);
    var d = dSlice.reduce(function (a, b) { return a + b; }, 0) / dSlice.length;
    return { k: k, d: d };
  }

  function aggregate(rows, bucketMs) {
    var out = [];
    var cur = null;
    (rows || []).forEach(function (row) {
      var stamp = Number(row.t);
      if (!isFinite(stamp) || !(row.close > 0)) return;
      var bucket = Math.floor(stamp / bucketMs) * bucketMs;
      if (!cur || cur.t !== bucket) {
        if (cur) out.push(cur);
        cur = { t: bucket, open: row.open, high: row.high, low: row.low, close: row.close };
      } else {
        cur.high = Math.max(cur.high, row.high);
        cur.low = Math.min(cur.low, row.low);
        cur.close = row.close;
      }
    });
    if (cur) out.push(cur);
    return out;
  }

  function tfSide(rows) {
    var values = closesOf(rows);
    if (values.length < 22) return null;
    var fast = ema(values, 9);
    var slow = ema(values, 21);
    var net = values[values.length - 1] - values[Math.max(0, values.length - 5)];
    if (fast > slow && net > 0) return 'UP';
    if (fast < slow && net < 0) return 'DOWN';
    return null;
  }

  function rangePos(rows) {
    var slice = (rows || []).slice(-20);
    if (slice.length < 8) return 0.5;
    var hi = slice[0].high;
    var lo = slice[0].low;
    slice.forEach(function (row) {
      hi = Math.max(hi, row.high);
      lo = Math.min(lo, row.low);
    });
    var span = hi - lo;
    if (!(span > 0)) return 0.5;
    return (slice[slice.length - 1].close - lo) / span;
  }

  function decide(input) {
    input = input || {};
    var cfg = settingsFor(input.pair);
    var m1 = input.m1 || [];
    var now = Number(input.now || 0);
    var newest = Number(input.lastTickAt || (m1.length ? m1[m1.length - 1].t : 0));
    var dataAge = now && newest ? Math.max(0, now - newest) : 0;
    var reasons = [];
    function none(reason) {
      return card('NO_TRADE', 0, 0, 'UNCERTAIN', reason, dataAge, input, {});
    }
    if (m1.length < 60) return none('Мало закрытых минутных свечей.');
    if (now && newest && dataAge > cfg.maxDataAgeMs) return none('Котировка устарела: ' + dataAge + ' мс.');

    var values = closesOf(m1);
    var price = values[values.length - 1];
    var e9 = ema(values, 9);
    var e21 = ema(values, 21);
    var e50 = ema(values, 50);
    var e200 = values.length >= 200 ? ema(values, 200) : null;
    var trendAdx = adx(m1, 14);
    var osc = rsi(values, 14);
    var macdNow = macd(values);
    var stoch = stochastic(m1);
    var bands = bollinger(values);
    var vol = atrPack(m1, 14);
    var m3 = input.m3 && input.m3.length ? input.m3 : aggregate(m1, 180000);
    var m5 = input.m5 && input.m5.length ? input.m5 : aggregate(m1, 300000);
    var m15 = input.m15 && input.m15.length ? input.m15 : aggregate(m1, 900000);

    var trend = { up: 0, down: 0 };
    if (e9 != null && e21 != null) {
      if (e9 > e21) trend.up += 30; else trend.down += 30;
    }
    if (e21 != null && e50 != null) {
      if (e21 > e50) trend.up += 25; else trend.down += 25;
    }
    if (e50 != null) {
      if (price > e50) trend.up += 20; else trend.down += 20;
    }
    if (e200 != null) {
      if (price > e200) trend.up += 15; else trend.down += 15;
    }
    if (trendAdx.adx != null && trendAdx.adx >= 20) {
      if (trendAdx.plusDI > trendAdx.minusDI) trend.up += 10;
      else if (trendAdx.minusDI > trendAdx.plusDI) trend.down += 10;
    }

    var momentum = { up: 0, down: 0 };
    var alignedUp = e9 != null && e21 != null && e50 != null && e9 > e21 && e21 > e50;
    var alignedDown = e9 != null && e21 != null && e50 != null && e9 < e21 && e21 < e50;
    if (osc != null) {
      if (alignedUp && osc >= 55) momentum.up += 34;
      else if (alignedDown && osc <= 45) momentum.down += 34;
      else if (osc >= 52 && osc <= 68) momentum.up += 34;
      else if (osc >= 32 && osc <= 48) momentum.down += 34;
    }
    if (macdNow) {
      var rising = macdNow.macd > macdNow.prev;
      var falling = macdNow.macd < macdNow.prev;
      if (macdNow.macd > macdNow.signal && macdNow.macd > 0 && rising) momentum.up += 40;
      else if (macdNow.macd < macdNow.signal && macdNow.macd < 0 && falling) momentum.down += 40;
      else if (macdNow.macd > 0 && rising) momentum.up += 20;
      else if (macdNow.macd < 0 && falling) momentum.down += 20;
    }
    if (stoch) {
      if (alignedUp) {
        if (stoch.k >= 60) momentum.up += 26;
      } else if (alignedDown) {
        if (stoch.k <= 40) momentum.down += 26;
      } else if (stoch.k > stoch.d && stoch.k < 80) momentum.up += 26;
      else if (stoch.k < stoch.d && stoch.k > 20) momentum.down += 26;
    }

    var tradable = 80;
    var ratio = vol.ratio;
    if (vol.atr != null && price > 0 && vol.atr / price < 0.00004) tradable = 15;
    else if (ratio == null) tradable = 40;
    else if (ratio < 0.45) tradable = 15;
    else if (ratio > 2.2) tradable = 20;
    else if (ratio > 1.6) tradable = 50;

    var action = { up: 0, down: 0 };
    var slice = m1.slice(-6);
    var higherHigh = 0;
    var higherLow = 0;
    var lowerHigh = 0;
    var lowerLow = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].high > slice[i - 1].high) higherHigh += 1; else lowerHigh += 1;
      if (slice[i].low > slice[i - 1].low) higherLow += 1; else lowerLow += 1;
    }
    if (higherHigh >= 3 && higherLow >= 3) action.up += 60;
    if (lowerHigh >= 3 && lowerLow >= 3) action.down += 60;
    var last3 = values.slice(-3);
    if (last3.length === 3) {
      if (last3[2] > last3[0]) action.up += 20;
      else if (last3[2] < last3[0]) action.down += 20;
    }
    var last = m1[m1.length - 1];
    if (last.close < last.open && action.up > action.down) action.up = Math.max(0, action.up - 25);
    if (last.close > last.open && action.down > action.up) action.down = Math.max(0, action.down - 25);

    var pos = rangePos(m1);
    var levels = { up: 20, down: 20 };
    if (alignedUp && price > e21) levels.up += 40;
    else if (alignedDown && price < e21) levels.down += 40;
    else if (pos <= 0.25) levels.up += 50;
    else if (pos >= 0.75) levels.down += 50;

    var side3 = tfSide(m3);
    var side5 = tfSide(m5);
    var side15 = tfSide(m15);
    var mtf = { up: 0, down: 0 };
    if (side3 === 'UP') mtf.up += 40; else if (side3 === 'DOWN') mtf.down += 40;
    if (side5 === 'UP') mtf.up += 35; else if (side5 === 'DOWN') mtf.down += 35;
    if (side15 === 'UP') mtf.up += 25; else if (side15 === 'DOWN') mtf.down += 25;

    var w = cfg.weights;
    var weightSum = w.trend + w.momentum + w.priceAction + w.levels + w.mtf;
    var upScore = (w.trend * trend.up + w.momentum * momentum.up + w.priceAction * action.up + w.levels * levels.up + w.mtf * mtf.up) / weightSum;
    var downScore = (w.trend * trend.down + w.momentum * momentum.down + w.priceAction * action.down + w.levels * levels.down + w.mtf * mtf.down) / weightSum;
    upScore = clamp(Math.round(upScore), 0, 100);
    downScore = clamp(Math.round(downScore), 0, 100);

    var state = 'UNCERTAIN';
    if (vol.atr != null && price > 0 && vol.atr / price < 0.00004) state = 'LOW_VOLATILITY';
    else if (ratio != null && ratio < 0.45) state = 'LOW_VOLATILITY';
    else if (ratio != null && ratio > 2.2) state = 'HIGH_VOLATILITY';
    else if (trendAdx.adx != null && trendAdx.adx >= 22 && trend.up >= trend.down + 25) state = 'TREND_UP';
    else if (trendAdx.adx != null && trendAdx.adx >= 22 && trend.down >= trend.up + 25) state = 'TREND_DOWN';
    else if (trendAdx.adx != null && trendAdx.adx < 18) state = 'RANGE';

    var direction = upScore >= downScore ? 'UP' : 'DOWN';
    var score = Math.max(upScore, downScore);
    var gap = Math.abs(upScore - downScore);
    var blocks = [];
    if (tradable < 40) blocks.push(state === 'LOW_VOLATILITY' ? 'Слишком тихий рынок.' : 'Слишком рваный рынок.');
    if (state === 'UNCERTAIN') blocks.push('Состояние рынка неясно.');
    if (state === 'TREND_UP' && direction === 'DOWN') blocks.push('Минутный счёт против восходящего контекста.');
    if (state === 'TREND_DOWN' && direction === 'UP') blocks.push('Минутный счёт против нисходящего контекста.');
    if (state === 'RANGE' && pos > 0.25 && pos < 0.75) blocks.push('Флэт в середине диапазона.');
    if (side5 && side5 !== direction) blocks.push('5м против минутного направления.');
    if (score < cfg.minScore) blocks.push('Счёт ' + score + ' ниже порога ' + cfg.minScore + '.');
    if (gap < cfg.minGap) blocks.push('Стороны слишком близко: ' + upScore + ' / ' + downScore + '.');

    var snapshot = {
      ema9: round(e9, 5),
      ema21: round(e21, 5),
      ema50: round(e50, 5),
      ema200: round(e200, 5),
      rsi: round(osc, 2),
      macd: macdNow ? round(macdNow.macd, 6) : null,
      macdSignal: macdNow ? round(macdNow.signal, 6) : null,
      macdHist: macdNow ? round(macdNow.hist, 6) : null,
      stochasticK: stoch ? round(stoch.k, 2) : null,
      stochasticD: stoch ? round(stoch.d, 2) : null,
      adx: round(trendAdx.adx, 2),
      plusDI: round(trendAdx.plusDI, 2),
      minusDI: round(trendAdx.minusDI, 2),
      atr: round(vol.atr, 6),
      bbUpper: bands ? round(bands.upper, 5) : null,
      bbMiddle: bands ? round(bands.mid, 5) : null,
      bbLower: bands ? round(bands.lower, 5) : null,
      vwap: null,
      support: round(m1.slice(-20).reduce(function (lo, row) { return Math.min(lo, row.low); }, Infinity), 5),
      resistance: round(m1.slice(-20).reduce(function (hi, row) { return Math.max(hi, row.high); }, -Infinity), 5),
      m3: side3,
      m5: side5,
      m15: side15
    };

    input._parts = { trend: trend, momentum: momentum, action: action, levels: levels, mtf: mtf, tradable: tradable };
    var shift = socketShift(input.ticks, now);
    if (shift && (!now || dataAge <= cfg.maxDataAgeMs)) {
      var shiftScore = direction === shift.side ? Math.max(score, 64) : 64;
      input._parts = { trend: trend, momentum: momentum, action: action, levels: levels, mtf: mtf, tradable: tradable, shift: shift.side };
      return card(shift.side, shift.side === 'UP' ? shiftScore : upScore, shift.side === 'DOWN' ? shiftScore : downScore, state, 'Сдвиг последних тиков сокета ' + (shift.side === 'UP' ? 'вверх' : 'вниз') + '. Следующая минута в сторону этого сдвига.', dataAge, input, snapshot, null, shiftScore);
    }
    input._parts = { trend: trend, momentum: momentum, action: action, levels: levels, mtf: mtf, tradable: tradable };
    if (blocks.length) return card('NO_TRADE', upScore, downScore, state, blocks.join(' '), dataAge, input, snapshot);
    var confirmed = {
      trend: (direction === 'UP' ? trend.up : trend.down) >= 55,
      momentum: (direction === 'UP' ? momentum.up : momentum.down) >= 40,
      volatility: tradable >= 50,
      priceAction: (direction === 'UP' ? action.up : action.down) >= 40,
      mtf: side5 === direction || side3 === direction
    };
    return card(direction, upScore, downScore, state, 'Независимые подтверждения сошлись.', dataAge, input, snapshot, confirmed, score);
  }

  function card(direction, upScore, downScore, state, reason, dataAge, input, snapshot, confirmed, score) {
    var strength = direction === 'NO_TRADE' ? Math.max(upScore, downScore) : (score || Math.max(upScore, downScore));
    var label = strength >= 90 ? 'VERY STRONG' : (strength >= 80 ? 'STRONG' : (strength >= 70 ? 'MODERATE' : (strength >= 60 ? 'WEAK' : 'NO TRADE')));
    if (direction === 'NO_TRADE') label = 'NO TRADE';
    var lines = [
      'PAIR: ' + (input.pair || ''),
      'TIMEFRAME: 1 MIN',
      'SIGNAL: ' + (direction === 'UP' ? 'CALL / UP' : (direction === 'DOWN' ? 'PUT / DOWN' : 'NO TRADE')),
      'EXPIRATION: 60 SEC',
      'SIGNAL SCORE: ' + strength + '/100 ' + label,
      'MARKET STATE: ' + state,
      'REASON: ' + reason,
      'DATA AGE: ' + dataAge + ' ms',
      'SCORE — это согласие факторов, не вероятность выигрыша.'
    ];
    if (confirmed) {
      lines.push('TREND: ' + (confirmed.trend ? 'CONFIRMED' : 'WEAK'));
      lines.push('MOMENTUM: ' + (confirmed.momentum ? 'CONFIRMED' : 'WEAK'));
      lines.push('VOLATILITY: ' + (confirmed.volatility ? 'NORMAL' : 'WEAK'));
      lines.push('PRICE ACTION: ' + (confirmed.priceAction ? 'CONFIRMED' : 'WEAK'));
      lines.push('MULTI-TIMEFRAME: ' + (confirmed.mtf ? 'CONFIRMED' : 'MIXED'));
    }
    return {
      direction: direction,
      wait: direction === 'NO_TRADE',
      isUp: direction === 'UP',
      up: upScore,
      down: downScore,
      score: strength,
      confidence: strength,
      accuracy: strength,
      marketState: state,
      reason: reason,
      dataAge: dataAge,
      reasons: lines,
      indicators: snapshot || {},
      parts: input && input._parts,
      reclaimSide: ''
    };
  }

  function statsOf(rows) {
    var wins = 0;
    var losses = 0;
    var pushes = 0;
    var streak = 0;
    var maxWin = 0;
    var maxLoss = 0;
    var grossWin = 0;
    var grossLoss = 0;
    rows.forEach(function (row) {
      if (row.result === 'WIN') {
        wins += 1;
        grossWin += 1;
        streak = streak >= 0 ? streak + 1 : 1;
        maxWin = Math.max(maxWin, streak);
      } else if (row.result === 'LOSS') {
        losses += 1;
        grossLoss += 1;
        streak = streak <= 0 ? streak - 1 : -1;
        maxLoss = Math.max(maxLoss, -streak);
      } else pushes += 1;
    });
    var decided = wins + losses;
    return {
      total: rows.length,
      wins: wins,
      losses: losses,
      pushes: pushes,
      winRate: decided ? Math.round(1000 * wins / decided) / 10 : null,
      profitFactor: grossLoss ? Math.round(100 * grossWin / grossLoss) / 100 : null,
      maxWinningStreak: maxWin,
      maxLosingStreak: maxLoss
    };
  }

  function backtest(rows, pair) {
    var start = 80;
    var booked = [];
    var noTrade = 0;
    for (var i = start; i < rows.length; i++) {
      var past = rows.slice(0, i);
      var decision = decide({
        pair: pair || '',
        m1: past,
        m5: aggregate(past, 300000),
        m15: aggregate(past, 900000),
        now: rows[i].t,
        lastTickAt: rows[i - 1].t + 60000
      });
      if (decision.direction === 'NO_TRADE') {
        noTrade += 1;
        continue;
      }
      var p0 = past[past.length - 1].close;
      var p60 = rows[i].close;
      var result = 'PUSH';
      if (p60 > p0) result = decision.direction === 'UP' ? 'WIN' : 'LOSS';
      else if (p60 < p0) result = decision.direction === 'DOWN' ? 'WIN' : 'LOSS';
      booked.push({
        signalTimestamp: rows[i - 1].t + 60000,
        expirationTimestamp: rows[i].t + 60000,
        entryTime: rows[i - 1].t + 60000,
        entry: p0,
        exit: p60,
        direction: decision.direction,
        score: decision.score,
        result: result,
        priceMethod: 'next_closed_minute'
      });
    }
    var evaluated = rows.length - start;
    function sliceStats(list) {
      return statsOf(list);
    }
    var cut1 = Math.floor(booked.length * 0.5);
    var cut2 = Math.floor(booked.length * 0.75);
    return {
      pair: pair || '',
      evaluatedBars: evaluated,
      noTrade: noTrade,
      noTradePct: evaluated ? Math.round(1000 * noTrade / evaluated) / 10 : null,
      all: sliceStats(booked),
      train: sliceStats(booked.slice(0, cut1)),
      validation: sliceStats(booked.slice(cut1, cut2)),
      outOfSample: sliceStats(booked.slice(cut2))
    };
  }

  function socketShift(ticks, now) {
    var prices = [];
    (ticks || []).forEach(function (tick) {
      var stamp = Number(tick && (tick.t || tick[0]) || 0);
      if (stamp > 0 && stamp < 1000000000000) stamp *= 1000;
      var price = Number(tick && (tick.price != null ? tick.price : tick[1]));
      if (now && stamp > now) return;
      if (price > 0) prices.push(price);
    });
    if (prices.length < 8) return null;
    var start = Math.max(0, prices.length - Math.ceil(prices.length / 3));
    var recent = prices.slice(start);
    var net = recent[recent.length - 1] - recent[0];
    var steps = [];
    for (var i = 1; i < prices.length; i++) steps.push(Math.abs(prices[i] - prices[i - 1]));
    steps.sort(function (a, b) { return a - b; });
    var typical = steps[Math.floor(steps.length / 2)] || 0;
    var minMove = Math.max(typical * 4, Math.abs(prices[prices.length - 1]) * 0.00003);
    if (net > minMove) return { side: 'UP', net: net };
    if (net < -minMove) return { side: 'DOWN', net: net };
    return null;
  }

  function timeMs(value) {
    var n = Number(value || 0);
    if (n > 0 && n < 1000000000000) n *= 1000;
    return n;
  }

  function resolveOutcome(row, ctx) {
    ctx = ctx || {};
    if (!row || row.result || row.signal === 'NO_TRADE' || row.signal === 'WAIT') return row;
    var exp = timeMs(row.expirationTimestamp || row.expiryAt);
    var p0 = Number(row.entry);
    if (!(exp > 0) || !(p0 > 0)) return row;
    var now = timeMs(ctx.now || Date.now());
    if (now < exp) return row;
    var best = null;
    (ctx.ticks || []).forEach(function (tick) {
      var stamp = timeMs(tick && (tick.t || tick[0]));
      var price = Number(tick && (tick.price != null ? tick.price : tick[1]));
      if (!(price > 0) || !(stamp > 0) || stamp > exp) return;
      if (!best || stamp > best.t) best = { t: stamp, price: price };
    });
    if (!best) {
      (ctx.candles || []).forEach(function (candle) {
        var open = timeMs(candle.t || candle.time);
        var closeAt = open + 60000;
        if (!(candle.close > 0) || !(open > 0) || closeAt > exp) return;
        if (!best || closeAt > best.t) best = { t: closeAt, price: Number(candle.close) };
      });
    }
    if (!best) return row;
    row.exit = best.price;
    row.close = best.price;
    row.priceMethod = 'last_price_at_or_before_expiry';
    row.priceGapMs = exp - best.t;
    if (best.price === p0) row.result = 'PUSH';
    else if (row.signal === 'UP' || row.signal === 'CALL') row.result = best.price > p0 ? 'WIN' : 'LOSS';
    else row.result = best.price < p0 ? 'WIN' : 'LOSS';
    return row;
  }

  return {
    SETTINGS: SETTINGS,
    settingsFor: settingsFor,
    decide: decide,
    aggregate: aggregate,
    backtest: backtest,
    statsOf: statsOf,
    resolveOutcome: resolveOutcome
  };
});
