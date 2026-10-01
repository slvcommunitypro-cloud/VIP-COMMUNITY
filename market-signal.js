/* Next-minute direction from the latest Fibonacci impulse, candle points, and ticks.
   A single print against the impulse must not flip the call. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.VipMarket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.236, 1.272, 1.382, 1.5, 1.618, 1.786, 2.618];

  function pointSize(price) {
    var abs = Math.abs(price || 0);
    if (abs >= 100) return 0.01;
    if (abs >= 10) return 0.001;
    return 0.00001;
  }

  function formatPoints(delta, price) {
    var pts = Math.round((Number(delta) || 0) / pointSize(price));
    if (!isFinite(pts)) pts = 0;
    return (pts > 0 ? '+' : '') + pts + ' пт';
  }

  function fmt(price) {
    var abs = Math.abs(price || 0);
    var digits = abs >= 100 ? 2 : (abs >= 10 ? 3 : 5);
    return Number(price || 0).toFixed(digits);
  }

  function levelLabel(level) {
    if (level === 0) return '0';
    if (level === 1) return '100';
    return String(Math.round(level * 1000) / 10);
  }

  function tickPrices(ticks) {
    var out = [];
    (ticks || []).forEach(function (tk) {
      var time = 0;
      var price = NaN;
      if (Array.isArray(tk)) {
        time = Number(tk[0]);
        price = Number(tk[1]);
        if (!(price > 0) && tk.length > 2) {
          time = Number(tk[1]);
          price = Number(tk[2]);
        }
      } else if (tk && typeof tk === 'object') {
        time = Number(tk.t || tk.time || 0);
        price = Number(tk.price != null ? tk.price : tk.close);
      } else {
        price = Number(tk);
      }
      if (price > 0 && isFinite(price)) out.push({ t: time || out.length, price: price });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out.map(function (row) { return row.price; });
  }

  function tapeFromPrices(prices) {
    var up = 0;
    var down = 0;
    for (var i = 1; i < prices.length; i++) {
      var step = prices[i] - prices[i - 1];
      if (step > 0) up += 1;
      else if (step < 0) down += 1;
    }
    var mid = Math.max(1, Math.floor(prices.length / 2));
    var recent = prices[prices.length - 1] - prices[mid];
    var net = prices[prices.length - 1] - prices[0];
    var bias = 0;
    if (up >= down + 2 && net > 0) bias += 1;
    if (down >= up + 2 && net < 0) bias -= 1;
    if (recent > 0 && up >= down) bias += 1;
    if (recent < 0 && down >= up) bias -= 1;
    return { up: up, down: down, net: net, recent: recent, bias: bias, samples: prices.length };
  }

  function closesOf(rows, count) {
    var prices = [];
    (rows || []).slice(-count).forEach(function (row) {
      if (row && row.close > 0) prices.push(row.close);
    });
    return prices;
  }

  function readTape(ticks, rows) {
    var live = tickPrices(ticks).slice(-40);
    var minute = closesOf(rows, 8);
    var nowPrices = live.length >= 6 ? live.slice(-24) : closesOf(rows, 3);
    var shown = live.length >= 6 ? live : minute;
    var now = nowPrices.length >= 2 ? tapeFromPrices(nowPrices) : { up: 0, down: 0, net: 0, recent: 0, bias: 0, samples: 0 };
    var context = shown.length >= 2 ? tapeFromPrices(shown) : now;
    var price = shown.length ? shown[shown.length - 1] : (minute.length ? minute[minute.length - 1] : 0);
    context.pointsText = formatPoints(context.net, price);
    context.live = live.length >= 6;
    now.pointsText = formatPoints(now.net, price || (nowPrices[nowPrices.length - 1] || 0));
    return { context: context, now: now };
  }

  function structurePoints(rows) {
    var slice = (rows || []).slice(-6);
    var higher = 0;
    var lower = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].high >= slice[i - 1].high && slice[i].low >= slice[i - 1].low) higher += 1;
      else if (slice[i].high <= slice[i - 1].high && slice[i].low <= slice[i - 1].low) lower += 1;
    }
    return { higher: higher, lower: lower };
  }

  function fibRetracement(rows) {
    if (!rows || rows.length < 12) return null;
    var n = rows.length;
    var from = Math.max(0, n - 40);
    var hi = from;
    var lo = from;
    for (var i = from + 1; i < n; i++) {
      if (rows[i].high >= rows[hi].high) hi = i;
      if (rows[i].low <= rows[lo].low) lo = i;
    }
    if (hi === lo) return null;
    var spanPrice = Math.abs(rows[hi].high - rows[lo].low);
    var microFrom = Math.max(from, n - 8);
    var mhi = microFrom;
    var mlo = microFrom;
    for (var j = microFrom + 1; j < n; j++) {
      if (rows[j].high >= rows[mhi].high) mhi = j;
      if (rows[j].low <= rows[mlo].low) mlo = j;
    }
    var microSpan = Math.abs(rows[mhi].high - rows[mlo].low);
    var useMicro = mhi !== mlo && microSpan >= spanPrice * 0.382;
    var up;
    var start;
    var end;
    if (useMicro) {
      up = mhi > mlo;
      if (up) {
        start = { index: mlo, price: rows[mlo].low };
        end = { index: mhi, price: rows[mhi].high };
      } else {
        start = { index: mhi, price: rows[mhi].high };
        end = { index: mlo, price: rows[mlo].low };
      }
    } else if (lo < hi) {
      up = true;
      start = { index: lo, price: rows[lo].low };
      end = { index: hi, price: rows[hi].high };
    } else {
      up = false;
      start = { index: hi, price: rows[hi].high };
      end = { index: lo, price: rows[lo].low };
    }
    var span = start.price - end.price;
    if (!isFinite(span) || Math.abs(span) < Math.abs(end.price) * 0.00005) return null;
    var last = rows[n - 1].close;
    var ratio = (last - end.price) / span;
    var nearest = 0;
    var best = Infinity;
    FIB_LEVELS.forEach(function (level) {
      var dist = Math.abs(ratio - level);
      if (dist < best) {
        best = dist;
        nearest = level;
      }
    });
    return {
      up: up,
      start: start,
      end: end,
      span: span,
      ratio: ratio,
      nearest: nearest,
      atLevel: best <= 0.08 || ratio < 0.05,
      levels: FIB_LEVELS.map(function (level) {
        return { level: level, price: end.price + span * level };
      })
    };
  }

  function levelPrice(fib, level) {
    return fib.end.price + fib.span * level;
  }

  function closedMove(rows) {
    var slice = (rows || []).slice(-4);
    var up = 0;
    var down = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].close > slice[i - 1].close) up += 1;
      else if (slice[i].close < slice[i - 1].close) down += 1;
    }
    var net = slice.length >= 2 ? slice[slice.length - 1].close - slice[0].close : 0;
    return {
      up: up,
      down: down,
      net: net,
      rising: up >= 2 && up > down && net > 0,
      falling: down >= 2 && down > up && net < 0
    };
  }

  function sideUp(fib, move) {
    if (!fib) return !!(move && (move.rising || (!move.falling && move.net >= 0)));
    var placed = rangeZone(fib, fib.up ? (fib.end.price + fib.span * fib.ratio) : (fib.end.price + fib.span * fib.ratio));
    if (!placed) return !!(move && move.net >= 0);
    if (placed.zone === 'LOW') return true;
    if (placed.zone === 'HIGH') return false;
    return !fib.up;
  }

  function streakOf(rows) {
    var slice = (rows || []).slice(-4);
    if (slice.length < 4) return null;
    var color = 0;
    for (var i = 0; i < slice.length; i++) {
      var row = slice[i];
      if (!row || !(row.close > 0)) return null;
      var step = row.close > row.open ? 1 : (row.close < row.open ? -1 : 0);
      if (!step) return null;
      if (color && step !== color) return null;
      color = step;
    }
    return color > 0 ? 'UP' : 'DOWN';
  }

  function rangeZone(fib, price) {
    if (!fib || !(price > 0)) return null;
    var lo = Math.min(fib.start.price, fib.end.price);
    var hi = Math.max(fib.start.price, fib.end.price);
    var span = hi - lo;
    if (!(span > 0)) return null;
    var pos = (price - lo) / span;
    if (pos < 0) pos = 0;
    if (pos > 1) pos = 1;
    var zone = pos <= 0.382 ? 'LOW' : (pos >= 0.618 ? 'HIGH' : 'MID');
    return { zone: zone, pos: pos, lo: lo, hi: hi };
  }

  function minuteCall(fib, rows, ticks) {
    var pack = readTape(ticks, rows);
    var now = pack.now;
    var tape = pack.context;
    var move = closedMove(rows);
    var structure = structurePoints(rows);
    var when = ' Вход на открытии следующей минуты, экспирация на её закрытии. До этого открытия сторона не меняется.';
    var price = rows && rows.length ? rows[rows.length - 1].close : 0;
    var tapeNote = ' Закрытые минуты: ' + tape.pointsText + ' (' + move.up + ' вверх / ' + move.down + ' вниз).';
    var structNote = ' Свечи: выше предыдущей ' + structure.higher + ', ниже предыдущей ' + structure.lower + '.';
    var streak = streakOf(rows);
    var zone = rangeZone(fib, price);
    var isUp;
    var kind;
    if (streak === 'UP') {
      isUp = true;
      kind = 'extend-up';
    } else if (streak === 'DOWN') {
      isUp = false;
      kind = 'extend-down';
    } else if (zone && zone.zone === 'LOW') {
      isUp = true;
      kind = 'low';
    } else if (zone && zone.zone === 'HIGH') {
      isUp = false;
      kind = 'high';
    } else if (zone) {
      isUp = fib ? !fib.up : !!(move.rising || (!move.falling && move.net >= 0));
      kind = 'mid';
    } else {
      isUp = !!(move.rising || (!move.falling && (move.net > 0 || (move.net === 0 && rows && rows.length && rows[rows.length - 1].close >= rows[rows.length - 1].open))));
      kind = 'flow';
    }

    var reason;
    if (kind === 'extend-up') reason = 'Четыре зелёные свечи подряд. Продление вверх.';
    else if (kind === 'extend-down') reason = 'Четыре красные свечи подряд. Продление вниз.';
    else if (!fib || !zone) reason = (isUp ? 'Закрытые минуты вверх.' : 'Закрытые минуты вниз.');
    else {
      var place = levelLabel(fib.nearest);
      var at = levelPrice(fib, fib.nearest);
      var fromLevel = formatPoints(price - at, price);
      var pct = Math.round(zone.pos * 1000) / 10;
      var leg = 'Импульс ' + (fib.up ? 'вверх ' : 'вниз ') + fmt(fib.start.price) + ' → ' + fmt(fib.end.price) + '. ';
      var where = 'Фибо ' + place + '% (' + fmt(at) + ', ' + fromLevel + ' от уровня, позиция ' + pct + '% диапазона).';
      if (kind === 'low') reason = leg + where + ' Низ Фибоначчи. Коррекция от низа вверх.';
      else if (kind === 'high') reason = leg + where + ' Верх Фибоначчи. Коррекция сверху вниз.';
      else reason = leg + where + ' Середина Фибоначчи. Коррекция ' + (isUp ? 'вверх.' : 'вниз.');
    }
    reason += tapeNote + structNote;
    var accuracy = kind === 'extend-up' || kind === 'extend-down' ? 74 : (kind === 'mid' ? 64 : (kind === 'flow' ? 58 : 68));
    var card = finish(isUp, accuracy, reason + when, fib, tape, now, fib ? fib.nearest : 0);
    card.zone = zone ? zone.zone : 'FLOW';
    card.streak = streak;
    card.wait = false;
    return card;
  }

  function finish(isUp, accuracy, reason, fib, tape, now, level) {
    var text = reason;
    if (text.indexOf('CALL') < 0 && text.indexOf('PUT') < 0) {
      var word = isUp ? ' CALL.' : ' PUT.';
      if (text.indexOf(' Вход на открытии') >= 0) text = text.replace(' Вход на открытии', word + ' Вход на открытии');
      else text += word;
    }
    return {
      wait: false,
      isUp: isUp,
      accuracy: accuracy,
      reason: text,
      level: level,
      tape: tape,
      now: now,
      fib: fib || null
    };
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

  function lastOf(series) {
    return series && series.length ? series[series.length - 1] : null;
  }

  function rsiWilder(closes, period) {
    period = period || 14;
    if (!closes || closes.length < period + 1) return null;
    var gain = 0;
    var loss = 0;
    for (var i = 1; i <= period; i++) {
      var diff = closes[i] - closes[i - 1];
      if (diff >= 0) gain += diff;
      else loss -= diff;
    }
    var avgGain = gain / period;
    var avgLoss = loss / period;
    for (var j = period + 1; j < closes.length; j++) {
      var step = closes[j] - closes[j - 1];
      avgGain = (avgGain * (period - 1) + (step > 0 ? step : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (step < 0 ? -step : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  function macdRead(closes) {
    var fast = emaSeries(closes, 12);
    var slow = emaSeries(closes, 26);
    var line = [];
    var shared = Math.min(fast.length, slow.length);
    var fastTail = fast.slice(-shared);
    var slowTail = slow.slice(-shared);
    for (var i = 0; i < shared; i++) line.push(fastTail[i] - slowTail[i]);
    var signal = emaSeries(line, 9);
    if (!signal.length || line.length < 2) return null;
    var macd = line[line.length - 1];
    var sig = signal[signal.length - 1];
    var prevMacd = line[line.length - 2];
    var prevSig = signal.length > 1 ? signal[signal.length - 2] : sig;
    return {
      macd: macd,
      signal: sig,
      hist: macd - sig,
      prevHist: prevMacd - prevSig
    };
  }

  function adxRead(rows, period) {
    period = period || 14;
    if (!rows || rows.length < period * 2 + 2) return { adx: 0, plusDI: 0, minusDI: 0, ready: false };
    var tr = [];
    var plusDM = [];
    var minusDM = [];
    for (var i = 1; i < rows.length; i++) {
      var upMove = rows[i].high - rows[i - 1].high;
      var downMove = rows[i - 1].low - rows[i].low;
      plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
      tr.push(Math.max(
        rows[i].high - rows[i].low,
        Math.abs(rows[i].high - rows[i - 1].close),
        Math.abs(rows[i].low - rows[i - 1].close)
      ));
    }
    var atr = 0;
    var sp = 0;
    var sm = 0;
    for (var n = 0; n < period; n++) {
      atr += tr[n];
      sp += plusDM[n];
      sm += minusDM[n];
    }
    var dx = [];
    var plusDI = 0;
    var minusDI = 0;
    for (var j = period; j < tr.length; j++) {
      atr = atr - atr / period + tr[j];
      sp = sp - sp / period + plusDM[j];
      sm = sm - sm / period + minusDM[j];
      plusDI = atr ? 100 * sp / atr : 0;
      minusDI = atr ? 100 * sm / atr : 0;
      var den = plusDI + minusDI;
      dx.push(den ? 100 * Math.abs(plusDI - minusDI) / den : 0);
    }
    if (dx.length < period) return { adx: 0, plusDI: plusDI, minusDI: minusDI, ready: false };
    var adx = 0;
    for (var k = 0; k < period; k++) adx += dx[k];
    adx /= period;
    for (var q = period; q < dx.length; q++) adx = (adx * (period - 1) + dx[q]) / period;
    return { adx: adx, plusDI: plusDI, minusDI: minusDI, ready: true };
  }

  function atrRead(rows, period) {
    period = period || 14;
    if (!rows || rows.length < period + 1) return { atr: 0, recent: 0, base: 0, ready: false };
    var tr = [];
    for (var i = 1; i < rows.length; i++) {
      var prev = rows[i - 1].close;
      tr.push(Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - prev), Math.abs(rows[i].low - prev)));
    }
    var atr = 0;
    for (var n = 0; n < period; n++) atr += tr[n];
    atr /= period;
    for (var j = period; j < tr.length; j++) atr = (atr * (period - 1) + tr[j]) / period;
    function avg(list) {
      if (!list.length) return 0;
      return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
    }
    return {
      atr: atr,
      recent: avg(tr.slice(-5)),
      base: avg(tr.slice(-30)),
      ready: true
    };
  }

  function bollingerRead(closes) {
    var period = 20;
    if (!closes || closes.length < period + 1) return null;
    function band(slice) {
      var mean = slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
      var variance = slice.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / slice.length;
      var sd = Math.sqrt(variance);
      return { mid: mean, upper: mean + 2 * sd, lower: mean - 2 * sd, width: mean ? (4 * sd) / mean : 0 };
    }
    var now = band(closes.slice(-period));
    var prev = band(closes.slice(-period - 1, -1));
    now.prevWidth = prev.width;
    now.expanding = now.width > prev.width * 1.05;
    now.squeeze = prev.width > 0 && now.width < prev.width * 0.85;
    return now;
  }

  function structureRead(rows) {
    var slice = (rows || []).slice(-6);
    var empty = { up: 0, down: 0, name: 'мало свечей' };
    if (slice.length < 4) return empty;
    var higherHigh = 0;
    var higherLow = 0;
    var lowerHigh = 0;
    var lowerLow = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].high > slice[i - 1].high) higherHigh += 1;
      else lowerHigh += 1;
      if (slice[i].low > slice[i - 1].low) higherLow += 1;
      else lowerLow += 1;
    }
    var prev = slice.slice(0, -1);
    var prevHigh = Math.max.apply(null, prev.map(function (c) { return c.high; }));
    var prevLow = Math.min.apply(null, prev.map(function (c) { return c.low; }));
    var last = slice[slice.length - 1];
    if (last.high > prevHigh && last.close < prevHigh) return { up: 0, down: 2, name: 'ложный пробой хая' };
    if (last.low < prevLow && last.close > prevLow) return { up: 2, down: 0, name: 'ложный пробой лоя' };
    if (higherHigh >= 3 && higherLow >= 3) return { up: 2, down: 0, name: 'higher high / higher low' };
    if (lowerHigh >= 3 && lowerLow >= 3) return { up: 0, down: 2, name: 'lower high / lower low' };
    if (last.close > prevHigh) return { up: 1, down: 0, name: 'пробой локального хая' };
    if (last.close < prevLow) return { up: 0, down: 1, name: 'пробой локального лоя' };
    return { up: 0, down: 0, name: 'структура смешанная' };
  }

  function candleMomentum(rows) {
    var slice = (rows || []).slice(-6);
    if (slice.length < 4) return { up: 0, down: 0, note: 'мало свечей' };
    var up = 0;
    var down = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].close > slice[i - 1].close) up += 1;
      else if (slice[i].close < slice[i - 1].close) down += 1;
    }
    var net = slice[slice.length - 1].close - slice[0].close;
    if (down >= 3 && down > up && net < 0) return { up: 0, down: 1, note: 'последние закрытия ниже' };
    if (up >= 3 && up > down && net > 0) return { up: 1, down: 0, note: 'последние закрытия выше' };
    return { up: 0, down: 0, note: 'закрытия без перевеса' };
  }

  function recentTape(rows) {
    var slice = (rows || []).slice(-8);
    if (slice.length < 6) return { side: null, note: '' };
    var up = 0;
    var down = 0;
    var bar = 0;
    for (var i = 0; i < slice.length; i++) bar = Math.max(bar, slice[i].high - slice[i].low);
    for (var j = 1; j < slice.length; j++) {
      if (slice[j].close > slice[j - 1].close) up += 1;
      else if (slice[j].close < slice[j - 1].close) down += 1;
    }
    var net = slice[slice.length - 1].close - slice[0].close;
    var minMove = Math.max(bar * 1.2, Math.abs(slice[slice.length - 1].close) * 0.00008);
    if (down >= 4 && down > up + 1 && net < -minMove) {
      return { side: 'DOWN', note: 'Последние минуты закрываются вниз: ' + down + ' из ' + (slice.length - 1) + '.' };
    }
    if (up >= 4 && up > down + 1 && net > minMove) {
      return { side: 'UP', note: 'Последние минуты закрываются вверх: ' + up + ' из ' + (slice.length - 1) + '.' };
    }
    return { side: null, note: '' };
  }

  function sumFactors(factors) {
    var up = 0;
    var down = 0;
    (factors || []).forEach(function (factor) {
      up += factor.up || 0;
      down += factor.down || 0;
    });
    return { up: up, down: down };
  }

  function roundNum(value, digits) {
    if (value == null || !isFinite(value)) return null;
    var p = Math.pow(10, digits || 4);
    return Math.round(value * p) / p;
  }

  function scoreSide(rows) {
    var factors = [];
    var up = 0;
    var down = 0;
    var veto = false;
    var vetoReason = '';
    var closes = (rows || []).map(function (c) { return c.close; });
    var price = closes.length ? closes[closes.length - 1] : 0;
    var ema20 = lastOf(emaSeries(closes, 20));
    var ema50 = lastOf(emaSeries(closes, 50));
    var ema200 = closes.length >= 200 ? lastOf(emaSeries(closes, 200)) : null;
    var rsi = rsiWilder(closes, 14);
    var macd = macdRead(closes);
    var adx = adxRead(rows, 14);
    var atr = atrRead(rows, 14);
    var bands = bollingerRead(closes);
    var structure = structureRead(rows);
    var candles = candleMomentum(rows);

    if (ema20 != null && ema50 != null) {
      var gap = Math.abs(ema20 - ema50);
      var ranges = [];
      for (var n = Math.max(1, rows.length - 21); n < rows.length; n++) ranges.push(rows[n].high - rows[n].low);
      ranges.sort(function (a, b) { return a - b; });
      if (ranges.length > 4) ranges.pop();
      var usual = ranges.length ? ranges[Math.floor(ranges.length / 2)] : 0;
      var tangled = usual > 0 && gap < usual * 0.35 && gap < Math.abs(price) * 0.0002;
      if (tangled) {
        veto = true;
        vetoReason = 'EMA20 и EMA50 переплетены, рынок во флэте.';
        factors.push({ name: 'EMA', up: 0, down: 0, note: vetoReason });
      } else if (ema20 > ema50 && price >= ema20 && (ema200 == null || price >= ema200)) {
        up += 2;
        factors.push({ name: 'EMA', up: 2, down: 0, note: ema200 == null ? 'EMA20 выше EMA50, цена выше них.' : 'EMA20 выше EMA50, цена выше EMA200.' });
      } else if (ema20 < ema50 && price <= ema20 && (ema200 == null || price <= ema200)) {
        down += 2;
        factors.push({ name: 'EMA', up: 0, down: 2, note: ema200 == null ? 'EMA20 ниже EMA50, цена ниже них.' : 'EMA20 ниже EMA50, цена ниже EMA200.' });
      } else {
        factors.push({ name: 'EMA', up: 0, down: 0, note: 'Цена и средние смотрят в разные стороны.' });
      }
    } else {
      factors.push({ name: 'EMA', up: 0, down: 0, note: 'Мало свечей для EMA.' });
    }

    if (rsi == null) factors.push({ name: 'RSI', up: 0, down: 0, note: 'Мало свечей для RSI.' });
    else if (rsi >= 70) factors.push({ name: 'RSI', up: 0, down: 0, note: 'RSI ' + rsi.toFixed(1) + ': возможное истощение роста.' });
    else if (rsi <= 30) factors.push({ name: 'RSI', up: 0, down: 0, note: 'RSI ' + rsi.toFixed(1) + ': возможное истощение падения.' });
    else if (rsi > 55) {
      up += 1;
      factors.push({ name: 'RSI', up: 1, down: 0, note: 'RSI ' + rsi.toFixed(1) + ' подтверждает вверх.' });
    } else if (rsi < 45) {
      down += 1;
      factors.push({ name: 'RSI', up: 0, down: 1, note: 'RSI ' + rsi.toFixed(1) + ' подтверждает вниз.' });
    } else factors.push({ name: 'RSI', up: 0, down: 0, note: 'RSI ' + rsi.toFixed(1) + ' в середине.' });

    if (!macd) factors.push({ name: 'MACD', up: 0, down: 0, note: 'Мало свечей для MACD.' });
    else {
      var rising = macd.hist > macd.prevHist;
      var falling = macd.hist < macd.prevHist;
      var macdUp = 0;
      var macdDown = 0;
      if (macd.macd > macd.signal && macd.macd > 0 && rising) macdUp = 2;
      else if (macd.macd < macd.signal && macd.macd < 0 && falling) macdDown = 2;
      else if (macd.macd > macd.signal && macd.macd > 0) macdUp = 1;
      else if (macd.macd < macd.signal && macd.macd < 0) macdDown = 1;
      else if (macd.macd > 0 && rising) macdUp = 1;
      else if (macd.macd < 0 && falling) macdDown = 1;
      up += macdUp;
      down += macdDown;
      factors.push({
        name: 'MACD',
        up: macdUp,
        down: macdDown,
        note: 'MACD ' + (macd.macd >= 0 ? 'выше нуля' : 'ниже нуля') + ', гистограмма ' + (rising ? 'растёт' : (falling ? 'падает' : 'плоская')) + '.'
      });
    }

    if (!adx.ready) factors.push({ name: 'ADX', up: 0, down: 0, note: 'Мало свечей для ADX.' });
    else if (adx.adx < 20) {
      veto = true;
      vetoReason = vetoReason || ('ADX ' + adx.adx.toFixed(1) + ': флэт, сигнал не выдаю.');
      factors.push({ name: 'ADX', up: 0, down: 0, note: vetoReason });
    } else if (adx.plusDI > adx.minusDI) {
      up += 1;
      factors.push({ name: 'ADX', up: 1, down: 0, note: 'ADX ' + adx.adx.toFixed(1) + ', +DI выше -DI.' });
    } else if (adx.minusDI > adx.plusDI) {
      down += 1;
      factors.push({ name: 'ADX', up: 0, down: 1, note: 'ADX ' + adx.adx.toFixed(1) + ', -DI выше +DI.' });
    } else factors.push({ name: 'ADX', up: 0, down: 0, note: 'ADX ' + adx.adx.toFixed(1) + ', DI равны.' });

    if (atr.ready && atr.base > 0 && (atr.recent < atr.base * 0.45 || atr.recent > atr.base * 2.6)) {
      veto = true;
      vetoReason = vetoReason || (atr.recent < atr.base * 0.45 ? 'ATR: движение слишком тихое.' : 'ATR: движение слишком рваное.');
      factors.push({ name: 'ATR', up: 0, down: 0, note: vetoReason });
    } else if (atr.ready) factors.push({ name: 'ATR', up: 0, down: 0, note: 'ATR в рабочем диапазоне, сторону не выбирает.' });
    else factors.push({ name: 'ATR', up: 0, down: 0, note: 'Мало свечей для ATR.' });

    if (!bands) factors.push({ name: 'Bollinger', up: 0, down: 0, note: 'Мало свечей для полос.' });
    else {
      var bbUp = 0;
      var bbDown = 0;
      var note = bands.squeeze ? 'Полосы сжимаются.' : (bands.expanding ? 'Полосы расширяются.' : 'Ширина полос обычная.');
      if (!bands.squeeze && price > bands.upper && rows[rows.length - 1].close >= rows[rows.length - 1].open && bands.expanding) {
        bbUp = 1;
        note = 'Выход вверх из диапазона при расширении.';
      } else if (!bands.squeeze && price < bands.lower && rows[rows.length - 1].close <= rows[rows.length - 1].open && bands.expanding) {
        bbDown = 1;
        note = 'Выход вниз из диапазона при расширении.';
      } else if (price > bands.mid && rows.length > 2 && rows[rows.length - 2].close < bands.mid) {
        bbUp = 1;
        note = 'Возврат выше средней линии Боллинджера.';
      } else if (price < bands.mid && rows.length > 2 && rows[rows.length - 2].close > bands.mid) {
        bbDown = 1;
        note = 'Возврат ниже средней линии Боллинджера.';
      }
      up += bbUp;
      down += bbDown;
      factors.push({ name: 'Bollinger', up: bbUp, down: bbDown, note: note });
    }

    up += structure.up;
    down += structure.down;
    factors.push({ name: 'Структура', up: structure.up, down: structure.down, note: structure.name });
    up += candles.up;
    down += candles.down;
    factors.push({ name: 'Свечи', up: candles.up, down: candles.down, note: candles.note });

    return {
      up: up,
      down: down,
      veto: veto,
      vetoReason: vetoReason,
      factors: factors,
      indicators: {
        ema20: roundNum(ema20, 5),
        ema50: roundNum(ema50, 5),
        ema200: roundNum(ema200, 5),
        rsi: roundNum(rsi, 2),
        macd: macd ? roundNum(macd.macd, 6) : null,
        macdSignal: macd ? roundNum(macd.signal, 6) : null,
        macdHist: macd ? roundNum(macd.hist, 6) : null,
        adx: roundNum(adx.adx, 2),
        plusDI: roundNum(adx.plusDI, 2),
        minusDI: roundNum(adx.minusDI, 2),
        atr: roundNum(atr.atr, 6),
        bbUpper: bands ? roundNum(bands.upper, 5) : null,
        bbMiddle: bands ? roundNum(bands.mid, 5) : null,
        bbLower: bands ? roundNum(bands.lower, 5) : null,
        structure: structure.name
      }
    };
  }

  function priceReclaim(rows) {
    if (!rows || rows.length < 55) return null;
    var closes = rows.map(function (c) { return c.close; });
    var fast = lastOf(emaSeries(closes, 20));
    var slow = lastOf(emaSeries(closes, 50));
    if (fast == null || slow == null) return null;
    var last = rows[rows.length - 1];
    var price = last.close;
    var bull = last.close > last.open;
    var bear = last.close < last.open;
    if (fast < slow && price > fast && price > slow) {
      return {
        side: bull ? 'UP' : 'WAIT',
        note: bull
          ? 'Цена закрылась выше EMA20 и EMA50. Старое падение для следующей минуты закончилось.'
          : 'Цена уже выше EMA20 и EMA50. Продолжение вниз не даю.'
      };
    }
    if (fast > slow && price < fast && price < slow) {
      return {
        side: bear ? 'DOWN' : 'WAIT',
        note: bear
          ? 'Цена закрылась ниже EMA20 и EMA50. Старый рост для следующей минуты закончился.'
          : 'Цена уже ниже EMA20 и EMA50. Продолжение вверх не даю.'
      };
    }
    return null;
  }

  function applyTurn(main, turn) {
    var against = { EMA: 1, RSI: 1, MACD: 1, ADX: 1, Bollinger: 1, 'Структура': 1, 'Свечи': 1, 'Минуты': 1 };
    main.factors.forEach(function (factor) {
      if (!against[factor.name]) return;
      if (turn.side === 'UP' && factor.down) {
        factor.down = 0;
        factor.note += ' Цена уже выше средних.';
      }
      if (turn.side === 'DOWN' && factor.up) {
        factor.up = 0;
        factor.note += ' Цена уже ниже средних.';
      }
    });
    main.factors.push({
      name: 'Цена',
      up: turn.side === 'UP' ? 4 : 0,
      down: turn.side === 'DOWN' ? 4 : 0,
      note: turn.note
    });
    var totals = sumFactors(main.factors);
    main.up = totals.up;
    main.down = totals.down;
  }

  function exhaustion(rows, rsi) {
    if (rsi == null || !rows || rows.length < 10) return null;
    var last = rows[rows.length - 1];
    var prior = rows.slice(-8, -1);
    var priorNet = prior[prior.length - 1].close - prior[0].close;
    var span = Math.max(last.high - last.low, Math.abs(last.close) * 0.00005);
    var body = Math.abs(last.close - last.open);
    var green = last.close > last.open;
    var red = last.close < last.open;
    var priorLow = Math.min.apply(null, prior.map(function (c) { return c.low; }));
    var priorHigh = Math.max.apply(null, prior.map(function (c) { return c.high; }));
    var strongRed = red && body > span * 0.55 && last.low <= priorLow;
    var strongGreen = green && body > span * 0.55 && last.high >= priorHigh;
    if (rsi <= 32 && priorNet < 0) {
      if (strongRed) return null;
      return { side: 'UP', note: 'RSI ' + rsi.toFixed(1) + ' на дне, свеча больше не продаёт. Следующая минута вверх.' };
    }
    if (rsi >= 68 && priorNet > 0) {
      if (strongGreen) return null;
      return { side: 'DOWN', note: 'RSI ' + rsi.toFixed(1) + ' на хаях, свеча больше не покупает. Следующая минута вниз.' };
    }
    return null;
  }

  function scoreBoard(m1, m5, liveRows) {
    var main = scoreSide(m1 || []);
    var slow = m5 && m5.length >= 40 ? scoreSide(m5) : null;
    var wait = false;
    var notes = [];
    if (!m1 || m1.length < 40) {
      wait = true;
      notes.push('Мало закрытых свечей для счёта.');
    }
    if (main.veto) {
      wait = true;
      notes.push(main.vetoReason);
    }
    var slowSide = slow ? (slow.up === slow.down ? 'FLAT' : (slow.up > slow.down ? 'UP' : 'DOWN')) : null;
    var mainSide = main.up === main.down ? 'FLAT' : (main.up > main.down ? 'UP' : 'DOWN');
    var tape = recentTape(m1);
    var reversal = tape.side && tape.side !== mainSide;
    if (reversal) {
      var late = { EMA: 1, RSI: 1, MACD: 1, ADX: 1, Bollinger: 1 };
      main.factors.forEach(function (factor) {
        if (!late[factor.name]) return;
        if (tape.side === 'DOWN' && factor.up) {
          factor.up = 0;
          factor.note += ' Это ещё прошлый рост, следующую минуту не решает.';
        }
        if (tape.side === 'UP' && factor.down) {
          factor.down = 0;
          factor.note += ' Это ещё прошлое падение, следующую минуту не решает.';
        }
      });
      main.factors.push({
        name: 'Минуты',
        up: tape.side === 'UP' ? 4 : 0,
        down: tape.side === 'DOWN' ? 4 : 0,
        note: tape.note
      });
      var turned = sumFactors(main.factors);
      main.up = turned.up;
      main.down = turned.down;
      mainSide = tape.side;
      wait = false;
      notes = [];
    } else if (slow && !slow.veto && slowSide && slowSide !== 'FLAT' && mainSide !== 'FLAT' && slowSide !== mainSide && Math.max(slow.up, slow.down) >= 5 && !tape.side) {
      wait = true;
      notes.push('M5 ' + (slowSide === 'UP' ? 'вверх' : 'вниз') + ', M1 ' + (mainSide === 'UP' ? 'вверх' : 'вниз') + '. Последние минуты без явного хода, сделки нет.');
    }
    var turn = priceReclaim(liveRows && liveRows.length >= 55 ? liveRows : m1);
    var reclaimSide = '';
    if (turn && turn.side === 'WAIT') {
      wait = true;
      notes = [turn.note];
      reclaimSide = 'WAIT';
    } else if (turn) {
      applyTurn(main, turn);
      wait = false;
      notes = [];
      reclaimSide = turn.side;
    }
    var spentRsi = main.indicators ? main.indicators.rsi : null;
    if (liveRows && liveRows.length > 20) {
      var spentLive = rsiWilder(liveRows.map(function (c) { return c.close; }), 14);
      if (spentLive != null) spentRsi = spentLive;
    }
    var spent = exhaustion(liveRows && liveRows.length >= 10 ? liveRows : m1, spentRsi);
    if (spent && spent.side === 'WAIT') {
      wait = true;
      notes = [spent.note];
      reclaimSide = 'WAIT';
    } else if (spent) {
      applyTurn(main, spent);
      wait = false;
      notes = [];
      reclaimSide = spent.side;
    }
    var lead = Math.max(main.up, main.down);
    var gap = Math.abs(main.up - main.down);
    if (!wait && !tape.side && !reclaimSide && !spent && (lead < 6 || gap < 3)) {
      wait = true;
      notes.push('Подтверждений мало: вверх ' + main.up + '/10, вниз ' + main.down + '/10.');
    }
    var isUp = reclaimSide === 'UP' ? true : (reclaimSide === 'DOWN' ? false : main.up > main.down);
    if (liveRows && liveRows.length > 20 && main.indicators) {
      var liveRsi = rsiWilder(liveRows.map(function (c) { return c.close; }), 14);
      if (liveRsi != null) main.indicators.rsi = roundNum(liveRsi, 2);
    }
    var confidence = Math.max(0, Math.min(100, Math.round((Math.min(lead, 10) / 10) * 100)));
    var lines = main.factors.map(function (factor) {
      var points = factor.up ? '+' + factor.up + ' вверх' : (factor.down ? '+' + factor.down + ' вниз' : '0');
      return factor.name + ' ' + points + ' — ' + factor.note;
    });
    var head = 'Вверх ' + main.up + '/10 · вниз ' + main.down + '/10. Сила модели ' + confidence + '%. Это согласие факторов, не вероятность выигрыша.';
    if (slowSide) head += ' M5: ' + (slowSide === 'UP' ? 'вверх' : (slowSide === 'DOWN' ? 'вниз' : 'без перевеса')) + '.';
    var reason = (wait ? 'ЖДАТЬ. ' + notes.join(' ') + ' ' : '') + head;
    return {
      wait: wait,
      isUp: isUp,
      up: main.up,
      down: main.down,
      max: 10,
      confidence: confidence,
      accuracy: confidence,
      factors: main.factors,
      indicators: main.indicators,
      m5: slowSide,
      reclaimSide: reclaimSide,
      reason: reason,
      reasons: [reason].concat(lines),
      veto: main.veto
    };
  }

  function aggregateCandles(rows, bucketMs) {
    var out = [];
    var cur = null;
    (rows || []).forEach(function (c) {
      var stamp = Number(c.t);
      if (!isFinite(stamp) || !(c.close > 0)) return;
      var bucket = Math.floor(stamp / bucketMs) * bucketMs;
      if (!cur || cur.t !== bucket) {
        if (cur) out.push(cur);
        cur = { t: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
      }
    });
    if (cur) out.push(cur);
    return out;
  }

  function legSide(rows) {
    var slice = (rows || []).slice(-8);
    if (slice.length < 4) return null;
    var up = 0;
    var down = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].close > slice[i - 1].close) up += 1;
      else if (slice[i].close < slice[i - 1].close) down += 1;
    }
    var net = slice[slice.length - 1].close - slice[0].close;
    if (up >= down + 2 && net > 0) return 'UP';
    if (down >= up + 2 && net < 0) return 'DOWN';
    return null;
  }

  function bounceFrom(rows) {
    var slice = (rows || []).slice(-20);
    if (slice.length < 8) return null;
    var hi = 0;
    var lo = 0;
    for (var i = 1; i < slice.length; i++) {
      if (slice[i].high >= slice[hi].high) hi = i;
      if (slice[i].low <= slice[lo].low) lo = i;
    }
    var last = slice[slice.length - 1];
    var prev = slice[slice.length - 2];
    var high = slice[hi].high;
    var low = slice[lo].low;
    var span = high - low;
    if (!(span > 0)) return null;
    var pos = (last.close - low) / span;
    if (lo > hi && pos <= 0.35 && last.close >= prev.close) return { from: 'low', price: low, side: 'UP' };
    if (hi > lo && pos >= 0.65 && last.close <= prev.close) return { from: 'high', price: high, side: 'DOWN' };
    return { from: pos < 0.5 ? 'low' : 'high', price: pos < 0.5 ? low : high, side: null };
  }

  var STACK = [
    { id: '5с', weight: 2 },
    { id: '15с', weight: 2 },
    { id: '30с', weight: 2 },
    { id: '1м', weight: 3 },
    { id: '5м', weight: 2 },
    { id: '10м', weight: 1 },
    { id: '15м', weight: 1 }
  ];

  function timeframeStack(frames) {
    frames = frames || {};
    var votes = [];
    var up = 0;
    var down = 0;
    var shortUp = 0;
    var shortDown = 0;
    STACK.forEach(function (tf) {
      var side = legSide(frames[tf.id]);
      votes.push({ id: tf.id, side: side });
      if (side === 'UP') up += tf.weight;
      else if (side === 'DOWN') down += tf.weight;
      if (tf.weight >= 2 && tf.id !== '5м') {
        if (side === 'UP') shortUp += 1;
        else if (side === 'DOWN') shortDown += 1;
      }
    });
    var bounce = bounceFrom(frames['1м'] || frames['5м'] || []);
    var shortSide = null;
    if (shortUp >= 3 && shortDown === 0) shortSide = 'UP';
    else if (shortDown >= 3 && shortUp === 0) shortSide = 'DOWN';
    var side = shortSide;
    if (!side && up >= down + 3) side = 'UP';
    else if (!side && down >= up + 3) side = 'DOWN';
    else if (!side && bounce && bounce.side) side = bounce.side;
    var parts = votes.map(function (vote) {
      return vote.id + ' ' + (vote.side === 'UP' ? 'вверх' : (vote.side === 'DOWN' ? 'вниз' : '—'));
    });
    var line = parts.join(', ') + '.';
    if (bounce && bounce.price) {
      line += ' Отталкивается от ' + (bounce.from === 'low' ? 'низа ' : 'верха ') + fmt(bounce.price) + '.';
    }
    if (side) line += ' Ближайшая минута ' + (side === 'UP' ? 'вверх.' : 'вниз.');
    return { votes: votes, up: up, down: down, side: side, shortSide: shortSide, bounce: bounce, line: line };
  }

  function blowoffSide(rows) {
    if (!rows || rows.length < 16) return null;
    var last = rows[rows.length - 1];
    var bodies = [];
    for (var i = Math.max(0, rows.length - 21); i < rows.length - 1; i++) {
      bodies.push(Math.abs(rows[i].close - rows[i].open));
    }
    bodies.sort(function (a, b) { return a - b; });
    var typical = bodies[Math.floor(bodies.length / 2)] || 0;
    var body = last.close - last.open;
    if (!(typical > 0) || Math.abs(body) < typical * 2.2) return null;
    return body > 0 ? 'UP' : 'DOWN';
  }

  function settleSignal(board, rows) {
    if (!board) return board;
    board.confidence = Math.max(0, Math.min(100, Math.round(Number(board.confidence) || 0)));
    board.accuracy = board.confidence;
    var spike = blowoffSide(rows);
    if (!spike) return board;
    var chasing = board.wait || (board.isUp && spike === 'UP') || (!board.isUp && spike === 'DOWN');
    if (!chasing) return board;
    board.isUp = spike !== 'UP';
    board.wait = false;
    board.reclaimSide = board.isUp ? 'UP' : 'DOWN';
    board.confidence = 58;
    board.accuracy = 58;
    var note = spike === 'UP'
      ? 'Последняя свеча слишком большая вверх. Следующая минута вниз.'
      : 'Последняя свеча слишком большая вниз. Следующая минута вверх.';
    board.reason = note;
    board.reasons = [note].concat(board.reasons || []);
    return board;
  }

  function gradeSignal(row, candles) {
    if (!row || row.result || !candles || !candles.length) return row;
    var bar = null;
    for (var i = 0; i < candles.length; i++) {
      var stamp = Number(candles[i].t || 0);
      if (Math.abs(stamp - Number(row.entryAt)) < 90000) bar = candles[i];
    }
    if (!bar) return row;
    if (row.entry == null) row.entry = bar.open;
    if (Date.now() < Number(row.expiryAt)) return row;
    row.close = bar.close;
    if (bar.close === bar.open) row.result = 'PUSH';
    else if (row.signal === 'UP') row.result = bar.close > bar.open ? 'WIN' : 'LOSS';
    else row.result = bar.close < bar.open ? 'WIN' : 'LOSS';
    return row;
  }

  return {
    FIB_LEVELS: FIB_LEVELS,
    fibRetracement: fibRetracement,
    minuteCall: minuteCall,
    readTape: readTape,
    formatPoints: formatPoints,
    closedMove: closedMove,
    sideUp: sideUp,
    streakOf: streakOf,
    rangeZone: rangeZone,
    scoreBoard: scoreBoard,
    scoreSide: scoreSide,
    gradeSignal: gradeSignal,
    settleSignal: settleSignal,
    aggregateCandles: aggregateCandles,
    timeframeStack: timeframeStack
  };
});
