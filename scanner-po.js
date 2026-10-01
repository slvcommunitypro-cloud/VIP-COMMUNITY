/* Scanner only. Quotes come from the same Pocket Option gateway as SLV VIP Community. */
(function () {
  var PO_API = '';
  var scanCategory = 'forex';
  var scanTf = 1;
  var liveCats = null;
  var liveTotal = 0;
  var scanPriceTimer = null;
  var scanExpiryTimer = null;
  var wired = false;

  function $(id) { return document.getElementById(id); }

  function apiBase() {
    try {
      var saved = localStorage.getItem('po_api_url');
      if (saved) return String(saved).replace(/\/$/, '');
    } catch (e) {}
    if (window.SERVER_URL) return String(window.SERVER_URL).replace(/\/$/, '');
    if (location.origin && location.origin.indexOf('http') === 0) return location.origin;
    return PO_API;
  }

  function norm(name) {
    return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function digitsFor(price) {
    return price >= 100 ? 2 : (price >= 10 ? 3 : 5);
  }

  function medianOf(arr) {
    if (!arr || !arr.length) return 0;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function sanitizeCandles(raw) {
    var src = Array.isArray(raw) ? raw : [];
    var rows = [];
    for (var i = 0; i < src.length; i++) {
      var c = src[i] || {};
      var open = Number(c.open), close = Number(c.close);
      if (!isFinite(open) || !isFinite(close) || open <= 0 || close <= 0) continue;
      var high = Number(c.high), low = Number(c.low);
      if (!isFinite(high)) high = Math.max(open, close);
      if (!isFinite(low)) low = Math.min(open, close);
      rows.push({
        t: c.t || 0,
        open: open,
        high: Math.max(high, open, close),
        low: Math.min(low, open, close),
        close: close
      });
    }
    return rows.map(function (c) {
      return {
        t: c.t,
        open: c.open,
        close: c.close,
        high: Math.max(c.high, c.open, c.close),
        low: Math.min(c.low, c.open, c.close)
      };
    });
  }

  function isPocketHistory(rows, source) {
    var src = String(source || '');
    if (!rows || rows.length < 8) return false;
    if (/pocketoption/i.test(src)) return true;
    if (/fallback|synth|yahoo|market/i.test(src)) return false;
    var ranged = 0;
    rows.forEach(function (c) {
      var scale = Math.abs(c.close) || 1;
      if ((c.high - c.low) > scale * 0.000008) ranged += 1;
    });
    return ranged / rows.length >= 0.25;
  }

  function sma(arr, n) {
    var slice = arr.slice(-Math.min(n, arr.length));
    return slice.reduce(function (a, b) { return a + b; }, 0) / (slice.length || 1);
  }

  function rsi(closes, period) {
    period = period || 14;
    if (!closes || closes.length < period + 1) return 50;
    var gains = 0, losses = 0, start = closes.length - period;
    for (var i = start; i < closes.length; i++) {
      var d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    var ag = gains / period, al = losses / period;
    if (al === 0) return 100;
    if (ag === 0) return 0;
    return 100 - (100 / (1 + ag / al));
  }

  function swingLevels(candles) {
    var slice = (candles || []).slice(-20);
    if (slice.length < 5) return { support: 0, resistance: 0 };
    var lows = slice.map(function (c) { return c.low; }).sort(function (a, b) { return a - b; });
    var highs = slice.map(function (c) { return c.high; }).sort(function (a, b) { return a - b; });
    return {
      support: medianOf(lows.slice(0, Math.max(3, Math.floor(lows.length * 0.25)))),
      resistance: medianOf(highs.slice(Math.floor(highs.length * 0.75)))
    };
  }

  function detectPattern(candles) {
    if (!candles || candles.length < 3) return { name: 'Нет формации', bias: 0 };
    var a = candles[candles.length - 2], b = candles[candles.length - 1];
    var bodyA = Math.abs(a.close - a.open), bodyB = Math.abs(b.close - b.open);
    var rangeB = Math.max(b.high - b.low, 1e-12);
    var upper = b.high - Math.max(b.open, b.close);
    var lower = Math.min(b.open, b.close) - b.low;
    var bullA = a.close >= a.open, bullB = b.close >= b.open;
    if (!bullA && bullB && b.close > a.open && b.open < a.close && bodyB > bodyA * 0.9) return { name: 'Бычье поглощение', bias: 2 };
    if (bullA && !bullB && b.close < a.open && b.open > a.close && bodyB > bodyA * 0.9) return { name: 'Медвежье поглощение', bias: -2 };
    if (lower > bodyB * 2 && upper < bodyB * 0.6 && bullB) return { name: 'Молот у поддержки', bias: 2 };
    if (upper > bodyB * 2 && lower < bodyB * 0.6 && !bullB) return { name: 'Падающая звезда', bias: -2 };
    if (bodyB / rangeB < 0.18) return { name: 'Доджи', bias: 0 };
    if (bullB && b.close > a.high) return { name: 'Импульс вверх', bias: 1 };
    if (!bullB && b.close < a.low) return { name: 'Импульс вниз', bias: -1 };
    return { name: 'Без явного паттерна', bias: 0 };
  }

  function fibRetracement(rows) {
    if (!window.VipMarket) return null;
    return window.VipMarket.fibRetracement(rows);
  }

  function settledBars(rows) {
    if (!rows || rows.length < 3) return rows || [];
    var last = rows[rows.length - 1];
    var start = Number(last.t || last.time || 0);
    if (start > 0 && start < 1000000000000) start *= 1000;
    var minuteStart = Math.floor(Date.now() / 60000) * 60000;
    if (start >= minuteStart) return rows.slice(0, -1);
    return rows;
  }

  function minuteCall(fib, rows, ticks) {
    if (!window.VipMarket || !rows || !rows.length) return null;
    return window.VipMarket.minuteCall(fib, rows, ticks);
  }

  function presentSignal(pair, tf, analysis) {
    var ms = Math.max(1, Number(tf) || 1) * 60000;
    var bucket = Math.floor(Date.now() / ms);
    var key = String(pair || '') + ':' + String(tf || 1) + ':' + bucket;
    if (!presentSignal.hold || presentSignal.hold.key !== key) {
      presentSignal.hold = { key: key, analysis: analysis };
    }
    var fixed = presentSignal.hold.analysis;
    return {
      isUp: fixed.isUp,
      wait: fixed.wait,
      entry: fixed.entry,
      last: analysis.last,
      sma9: fixed.sma9,
      sma20: fixed.sma20,
      rsi: fixed.rsi,
      vol: fixed.vol,
      levels: fixed.levels,
      accuracy: fixed.accuracy,
      score: fixed.score,
      pattern: fixed.pattern,
      fib: fixed.fib,
      zone: fixed.zone || '',
      pointsText: fixed.pointsText,
      reasons: fixed.reasons,
      closes: fixed.closes,
      up: fixed.up,
      down: fixed.down,
      confidence: fixed.confidence,
      indicators: fixed.indicators,
      factors: fixed.factors,
      reclaimSide: fixed.reclaimSide || '',
      lastBar: analysis.lastBar || fixed.lastBar,
      quoteAt: fixed.quoteAt || 0,
      receivedAt: fixed.receivedAt || 0,
      signalAt: fixed.signalAt || 0,
      latencyMs: fixed.latencyMs || 0,
      dataAge: fixed.dataAge,
      marketState: fixed.marketState || ''
    };
  }

  function analyzeMarket(candles, ticks, higher, frames, meta) {
    var series = sanitizeCandles(candles).slice(-400);
    if (!series.length) {
      return { wait: true, isUp: false, last: 0, entry: 0, accuracy: 50, rsi: 50, sma9: 0, sma20: 0, vol: 0, reasons: ['Нет котировок'], levels: { support: 0, resistance: 0 }, pattern: { name: '', bias: 0 } };
    }
    var closed = series.slice(0, -1);
    var use = closed.length >= 8 ? closed : series;
    var closes = use.map(function (c) { return c.close; });
    var last = series[series.length - 1].close;
    var lastClosed = use[use.length - 1];
    var sma9 = sma(closes, 9);
    var sma20 = sma(closes, Math.min(20, closes.length));
    var r = rsi(closes, 14);
    var levels = swingLevels(use);
    var pattern = detectPattern(use);
    var range = Math.max((levels.resistance - levels.support) || 0, last * 0.00015);
    var score = 0;
    if (lastClosed.close > sma9) score += 1; else score -= 1;
    if (sma9 > sma20) score += 1; else score -= 1;
    if (r < 30) score += 2; else if (r > 70) score -= 2; else if (r < 42) score += 1; else if (r > 58) score -= 1;
    score += pattern.bias;
    if (lastClosed.close <= levels.support + range * 0.16 && pattern.bias >= 0) score += 2;
    if (lastClosed.close >= levels.resistance - range * 0.16 && pattern.bias <= 0) score -= 2;
    var settled = settledBars(series);
    var decided = settled.length >= 4 ? settled : series;
    var fib = fibRetracement((decided.length ? decided : series).slice(-160));
    var fibCall = minuteCall(fib, (decided.length ? decided : series).slice(-160), ticks);
    var higherRows = higher ? settledBars(sanitizeCandles(higher).slice(-400)) : null;
    var board = null;
    if (window.SignalEngine && window.SignalEngine.decide) {
      var agg = window.SignalEngine.aggregate;
      var tickAt = 0;
      (ticks || []).forEach(function (tick) {
        var stamp = Number(tick && (tick.t || tick[0]) || 0);
        if (stamp > 10000000000 && stamp > tickAt) tickAt = stamp;
      });
      board = window.SignalEngine.decide({
        pair: frames && frames.pair,
        m1: decided,
        m3: agg ? agg(decided, 180000) : [],
        m5: (frames && frames['5м']) || higherRows || [],
        m15: (frames && frames['15м']) || [],
        now: Date.now(),
        lastTickAt: (meta && meta.quoteAt) || tickAt || (series.length ? series[series.length - 1].t : 0),
        ticks: ticks || []
      });
    }
    var wait = false;
    var drift = lastClosed.close - (use.length > 3 ? use[use.length - 4].close : lastClosed.open);
    var isUp = fibCall ? !!fibCall.isUp : drift >= 0;
    var accuracy = fibCall ? fibCall.accuracy : 64;
    var zoneName = fibCall && fibCall.zone === 'LOW' ? 'низ' : (fibCall && fibCall.zone === 'HIGH' ? 'верх' : (fibCall && fibCall.zone === 'MID' ? 'середина' : 'ход'));
    var reason = fibCall ? fibCall.reason : (isUp
      ? 'Фибоначчи: коррекция вверх. CALL на открытии следующей минуты.'
      : 'Фибоначчи: коррекция вниз. PUT на открытии следующей минуты.');
    var slice = use.slice(-20);
    var vol = 0;
    slice.forEach(function (c) { vol += (c.high - c.low) / (c.close || 1); });
    vol = slice.length ? (vol / slice.length) * 100 : 0;
    return {
      isUp: isUp, wait: wait, last: last, entry: last, sma9: sma9, sma20: sma20, rsi: r, vol: vol,
      levels: levels, accuracy: accuracy, score: accuracy, pattern: pattern, fib: fib,
      zone: fibCall ? fibCall.zone : '',
      pointsText: fibCall && fibCall.tape ? fibCall.tape.pointsText : '',
      up: isUp ? 7 : 3,
      down: isUp ? 3 : 7,
      confidence: accuracy,
      indicators: board ? board.indicators : null,
      factors: null,
      reclaimSide: isUp ? 'UP' : 'DOWN',
      reasons: [reason, 'Зона Фибоначчи: ' + zoneName + '.', pattern.name ? (pattern.name + ' · RSI ' + r.toFixed(1)) : ('RSI ' + r.toFixed(1))],
      closes: series.slice(-12).map(function (c) { return Number(c.close); }),
      lastBar: series.length ? series[series.length - 1] : null,
      quoteAt: meta && meta.quoteAt || 0,
      receivedAt: meta && meta.receivedAt || 0,
      signalAt: Date.now(),
      latencyMs: meta && meta.quoteAt ? Math.max(0, Date.now() - meta.quoteAt) : 0,
      marketState: zoneName === 'низ' ? 'ФИБО НИЗ' : (zoneName === 'верх' ? 'ФИБО ВЕРХ' : (zoneName === 'середина' ? 'ФИБО СЕРЕДИНА' : 'ФИБО'))
    };
  }

  function drawFib(ctx, fib, rows, y, padL, padR, step, w, h) {
    if (!fib) return;
    var xOf = function (index) { return padL + index * step + step / 2; };
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = 'rgba(30,230,135,0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(xOf(fib.start.index), y(fib.start.price));
    ctx.lineTo(xOf(fib.end.index), y(fib.end.price));
    ctx.stroke();
    ctx.setLineDash([]);
    fib.levels.forEach(function (lv) {
      var gy = y(lv.price);
      if (gy < 8 || gy > h - 8) return;
      var golden = lv.level === 0.618 || lv.level === 0.5 || lv.level === 0;
      ctx.strokeStyle = golden ? 'rgba(30,230,135,0.85)' : 'rgba(154,168,184,0.55)';
      ctx.lineWidth = lv.level === 0.618 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(padL + 34, gy);
      ctx.lineTo(w - padR, gy);
      ctx.stroke();
      ctx.fillStyle = golden ? '#1ee687' : '#9aa8b8';
      ctx.font = (lv.level === 0.618 ? 'bold ' : '') + '9px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(lv.level), 4, gy + 3);
    });
  }

  function fitCanvas(canvas) {
    if (!canvas) return {};
    var wrap = canvas.parentElement;
    var w = (wrap && wrap.clientWidth) || 340;
    var h = (wrap && wrap.clientHeight) || 240;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: w, h: h };
  }

  function drawPocketChart(candles, analysis) {
    var box = fitCanvas($('po-candle-canvas'));
    var ctx = box.ctx, w = box.w, h = box.h;
    if (!ctx) return;
    var rows = sanitizeCandles(candles).slice(-160);
    if (!rows.length) return;
    if (!isPocketHistory(rows, candles && candles.__source)) {
      ctx.fillStyle = '#0b1118';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#d5deea';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Нет истории свечей Pocket Option', w / 2, h / 2 - 8);
      ctx.fillStyle = '#8ea0b5';
      ctx.font = '11px sans-serif';
      ctx.fillText('Шлюз не подключён к сессии терминала', w / 2, h / 2 + 12);
      return;
    }
    ctx.fillStyle = '#0b1118';
    ctx.fillRect(0, 0, w, h);
    var padL = 36, padR = 64, padT = 14, padB = 16;
    var max = Math.max.apply(null, rows.map(function (c) { return c.high; }));
    var min = Math.min.apply(null, rows.map(function (c) { return c.low; }));
    var span = (max - min) || Math.abs(rows[rows.length - 1].close) * 0.0008;
    max += span * 0.1;
    min -= span * 0.1;
    function y(v) { return padT + (1 - (v - min) / (max - min)) * (h - padT - padB); }
    var step = (w - padL - padR) / rows.length;
    var cw = Math.max(2, Math.min(9, step * 0.7));
    var last = rows[rows.length - 1];
    var digits = digitsFor(last.close);
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.fillStyle = '#6d7d90';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    for (var i = 0; i < 5; i++) {
      var val = max - i * ((max - min) / 4);
      var gy = y(val);
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(w - padR, gy);
      ctx.stroke();
      ctx.fillText(val.toFixed(digits), w - 6, gy + 3);
    }
    var fib = (analysis && analysis.fib) || fibRetracement(rows);
    rows.forEach(function (c, idx) {
      var x = padL + idx * step + (step - cw) / 2;
      var up = c.close >= c.open;
      var color = up ? '#1ee687' : '#ff4d6d';
      var top = y(c.high);
      var bot = y(c.low);
      var y1 = y(Math.max(c.open, c.close));
      var y2 = y(Math.min(c.open, c.close));
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x + cw / 2, top);
      ctx.lineTo(x + cw / 2, bot);
      ctx.stroke();
      ctx.fillRect(x, y1, cw, Math.max(2, y2 - y1));
    });
    if (fib) drawFib(ctx, fib, rows, y, padL, padR, step, w, h);
    var quoteColor = last.close >= last.open ? '#1ee687' : '#ff4d6d';
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = quoteColor;
    ctx.beginPath();
    ctx.moveTo(padL, y(last.close));
    ctx.lineTo(w - padR, y(last.close));
    ctx.stroke();
    ctx.setLineDash([]);
    var tagY = Math.min(h - 18, Math.max(8, y(last.close) - 8));
    ctx.fillStyle = quoteColor;
    ctx.fillRect(w - padR + 3, tagY, padR - 7, 16);
    ctx.fillStyle = '#061018';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(last.close.toFixed(digits), w - padR / 2 + 1, tagY + 12);
  }

  function categoryOf(type, bucket) {
    var t = String(type || bucket || '').toLowerCase();
    if (t.indexOf('crypto') >= 0) return 'crypto';
    if (t.indexOf('commod') >= 0) return 'commodities';
    if (t.indexOf('stock') >= 0) return 'stocks';
    if (t.indexOf('index') >= 0 || t.indexOf('indice') >= 0) return 'indices';
    if (bucket === 'crypto' || bucket === 'commodities' || bucket === 'stocks' || bucket === 'indices' || bucket === 'forex') return bucket;
    return 'forex';
  }

  function absorbPayouts(data) {
    var cats = { forex: [], crypto: [], commodities: [], stocks: [], indices: [] };
    var map = { currencies: 'forex', forex: 'forex', crypto: 'crypto', commodities: 'commodities', stocks: 'stocks', indices: 'indices' };
    var groups = (data && data.categories) || {};
    Object.keys(groups).forEach(function (key) {
      var target = map[key] || categoryOf('', key);
      (groups[key] || []).forEach(function (row) {
        var display = row.display || row.symbol || row.pair || row.name;
        if (!display) return;
        cats[target].push({
          display: display,
          symbol: row.symbol || display,
          payout: Math.round(Number(row.payout || row.percent || 0)),
          active: row.active !== false
        });
      });
    });
    if (!cats.forex.length && data && data.pairs && typeof data.pairs === 'object') {
      Object.keys(data.pairs).forEach(function (sym) {
        var row = data.pairs[sym] || {};
        var display = row.display || sym;
        var target = categoryOf(row.type, '');
        cats[target].push({
          display: display,
          symbol: row.id || row.symbol || display,
          payout: Math.round(Number(row.payout || 0)),
          active: row.active !== false
        });
      });
    }
    var total = 0;
    Object.keys(cats).forEach(function (k) {
      var seen = {};
      cats[k] = cats[k].filter(function (row) {
        var id = norm(row.display);
        if (!id || seen[id]) return false;
        seen[id] = true;
        return true;
      });
      cats[k].sort(function (a, b) {
        var ao = a.active === false ? 1 : 0;
        var bo = b.active === false ? 1 : 0;
        if (ao !== bo) return ao - bo;
        return (b.payout || 0) - (a.payout || 0);
      });
      total += cats[k].length;
    });
    if (!total) return false;
    liveCats = cats;
    liveTotal = total;
    window.__SLV_LIVE_PAIRS__ = true;
    return true;
  }

  function activeCategory() {
    var ids = ['forex', 'crypto', 'commodities', 'stocks', 'indices'];
    for (var i = 0; i < ids.length; i++) {
      var btn = $('cat-' + ids[i]);
      if (!btn) continue;
      var bg = String(btn.style.background || '');
      if (bg.indexOf('neon-green') !== -1) return ids[i];
    }
    return scanCategory || 'forex';
  }

  function setPoStatus(text) {
    var el = $('slv-po-status');
    if (!el) {
      var count = $('total-assets-count');
      var host = count && count.parentElement;
      if (!host || !host.parentElement) return;
      el = document.createElement('div');
      el.id = 'slv-po-status';
      el.style.cssText = 'text-align:center;font-size:10px;color:#3d8bff;font-weight:800;margin-top:4px;letter-spacing:.4px;';
      host.parentElement.insertBefore(el, host.nextSibling);
    }
    el.textContent = text;
  }

  function renderLivePairs() {
    var renderBox = $('analysis-pairs-render-box');
    if (!renderBox || !liveCats) return false;
    var search = $('analysis-search-input');
    var q = search ? search.value.toUpperCase().trim() : '';
    var base = liveCats[activeCategory()] || [];
    var filtered = q ? base.filter(function (p) { return p.display.toUpperCase().indexOf(q) !== -1; }) : base.slice();
    renderBox.innerHTML = '';
    if (!filtered.length) {
      renderBox.innerHTML = '<div style="color:#9a9484;text-align:center;font-size:13px;padding:30px;font-weight:600;">Тикер не найден в этой категории.</div>';
    } else {
      filtered.forEach(function (pair) {
        var row = document.createElement('div');
        var closed = pair.active === false;
        row.className = 'pair-row';
        if (closed) {
          row.style.opacity = '0.45';
          row.style.cursor = 'default';
        } else {
          row.addEventListener('click', function () { window.launchFullscreenAnalysis(pair.display); });
        }
        var pay = '<span style="color:' + (closed ? '#8d97a6' : '#3dff8a') + ';font-weight:900;margin-right:8px;">' + (pair.payout || 0) + '%</span>';
        var top = !closed && pair.payout >= 92 ? ' <span style="font-size:10px;color:#1fd47a;font-weight:800;">92+</span>' : '';
        var state = closed
          ? '<span style="color:#ff4d6d;font-size:11px;font-weight:900;">ЗАКРЫТА</span>'
          : '<span style="color:var(--neon-green);font-size:13px;font-weight:900;">M1 →</span>';
        row.innerHTML = '<span>' + pair.display + top + '</span><span>' + pay + state + '</span>';
        renderBox.appendChild(row);
      });
    }
    var countEl = $('total-assets-count');
    if (countEl) countEl.textContent = String(liveTotal);
    return true;
  }

  async function refreshPocketPairs() {
    setPoStatus('POCKET OPTION • загрузка пар…');
    try {
      var res = await fetch(apiBase() + '/api/payouts', { cache: 'no-store' });
      if (!res.ok) throw new Error('payouts ' + res.status);
      var data = await res.json();
      if (!absorbPayouts(data)) throw new Error('empty payouts');
      var source = (data && data.source) || 'pocketoption';
      setPoStatus(source.indexOf('demo') >= 0 || source.indexOf('pocket') >= 0 ? 'POCKET OPTION • выплаты как в терминале' : 'POCKET OPTION • доска выплат');
      if (typeof window.filterAnalysisPairs === 'function') window.filterAnalysisPairs();
    } catch (e) {
      setPoStatus('POCKET OPTION • нет связи со шлюзом');
    }
  }

  var poLink = null;
  async function pocketConnected() {
    if (poLink && Date.now() - poLink.at < 15000) return poLink.ok;
    try {
      var res = await fetch(apiBase() + '/api/po/health', { cache: 'no-store' });
      var data = await res.json();
      poLink = { at: Date.now(), ok: !!(data && data.connected) };
    } catch (e) {
      poLink = { at: Date.now(), ok: false };
    }
    return poLink.ok;
  }

  async function fetchPocketCandles(pairName, tf, periodSeconds) {
    var period = periodSeconds || Math.max(60, Number(tf || 1) * 60);
    var pocketLive = await pocketConnected();
    var res = await fetch(apiBase() + '/api/candles?pair=' + encodeURIComponent(pairName) + '&period=' + period, { cache: 'no-store' });
    if (!res.ok) throw new Error('candles ' + res.status);
    var data = await res.json();
    var rows = (data && data.candles) || [];
    if (!rows.length) throw new Error('empty');
    return {
      candles: (function () {
        var list = sanitizeCandles(rows.map(function (c) {
          return { t: c.t || (c.time * 1000), open: +c.open, high: +c.high, low: +c.low, close: +c.close };
        }));
        var src = data.source || '';
        if (/pocketoption-demo/i.test(src)) src = 'pocketoption-demo';
        else if (/pocketoption-api/i.test(src)) src = 'pocketoption-api';
        else if (pocketLive) src = 'pocketoption-api';
        else src = src || 'fallback-market';
        list.__source = src;
        return list;
      })(),
      ticks: Array.isArray(data.ticks) ? data.ticks : [],
      quoteAt: Number(data.quoteAt) || 0,
      receivedAt: Number(data.receivedAt) || 0,
      source: /pocketoption-demo/i.test(data.source || '') ? 'pocketoption-demo' : ((data.source && /pocketoption-api/i.test(data.source)) ? data.source : (pocketLive ? 'pocketoption-api' : (data.source || 'fallback-market')))
    };
  }

  async function cachedCandles(pairName, seconds, ttl) {
    if (!cachedCandles.box) cachedCandles.box = {};
    var key = String(pairName || '') + ':' + seconds;
    var hit = cachedCandles.box[key];
    if (hit && Date.now() - hit.at < ttl && hit.candles) return hit.candles;
    try {
      var pack = await fetchPocketCandles(pairName, 1, seconds);
      cachedCandles.box[key] = { at: Date.now(), candles: pack.candles };
      return pack.candles;
    } catch (e) {
      return hit ? hit.candles : null;
    }
  }

  function buildFrames(s5, m1, m15) {
    var agg = window.VipMarket && window.VipMarket.aggregateCandles;
    var frames = {};
    if (!agg) return frames;
    if (s5 && s5.length) {
      frames['5с'] = s5;
      frames['15с'] = agg(s5, 15000);
      frames['30с'] = agg(s5, 30000);
    }
    if (m1 && m1.length) {
      frames['1м'] = m1;
      frames['5м'] = agg(m1, 300000);
      frames['10м'] = agg(m1, 600000);
      if (!m15) frames['15м'] = agg(m1, 900000);
    }
    if (m15 && m15.length) frames['15м'] = m15;
    return frames;
  }

  async function loadScan(pairName, tf) {
    var pack = await fetchPocketCandles(pairName, tf);
    var s5 = null;
    var m15 = null;
    if (Number(tf) === 1) {
      s5 = await cachedCandles(pairName, 5, 15000);
      m15 = await cachedCandles(pairName, 900, 180000);
    }
    var frames = buildFrames(s5, pack.candles, m15);
    frames.pair = pairName;
    return { pack: pack, m5: frames['5м'] || null, frames: frames };
  }

  function unlockScanScroll(overlay) {
    if (!overlay) return;
    overlay.style.setProperty('display', 'block', 'important');
    overlay.style.setProperty('overflow-x', 'hidden', 'important');
    overlay.style.setProperty('overflow-y', 'scroll', 'important');
    overlay.style.setProperty('height', '100dvh', 'important');
    overlay.style.setProperty('max-height', '100dvh', 'important');
    overlay.style.setProperty('-webkit-overflow-scrolling', 'touch');
    overlay.style.touchAction = 'pan-y';
    overlay.style.overscrollBehavior = 'contain';
    var desk = overlay.querySelector('.po-desk');
    if (desk) {
      desk.style.minHeight = 'auto';
      desk.style.height = 'auto';
      desk.style.overflow = 'visible';
    }
    var card = $('radar-final-result');
    if (card) {
      card.style.overflow = 'visible';
      card.style.maxHeight = 'none';
      card.style.maxWidth = '100%';
    }
    overlay.scrollTop = 0;
  }

  function ensureScanOverlay() {
    if ($('po-scan-overlay') || !$('po-chart-wrap')) return;
    if (!$('slv-po-scan-style')) {
      var style = document.createElement('style');
      style.id = 'slv-po-scan-style';
      style.textContent = '.po-price.neutral{color:#3d8bff}.po-scan-overlay{position:absolute;inset:0;z-index:6;display:none;align-items:center;justify-content:center;background:linear-gradient(180deg,rgba(6,12,18,.55),rgba(5,10,16,.78));overflow:hidden}.po-scan-overlay.active{display:flex}.po-scan-beam{position:absolute;top:0;bottom:0;width:42%;left:-40%;background:linear-gradient(90deg,transparent,rgba(61,139,255,.08),rgba(30,230,135,.22),rgba(61,139,255,.08),transparent);animation:poScanBeam 1.15s ease-in-out infinite}.po-scan-copy{position:relative;z-index:2;text-align:center;padding:0 18px}.po-scan-title{font-size:13px;letter-spacing:2.4px;color:#3d8bff;font-weight:800}.po-scan-sub{margin-top:8px;font-size:12px;font-weight:700;color:#d5deea}.po-scan-bar{width:180px;height:4px;margin:12px auto 0;background:rgba(255,255,255,.08);border-radius:99px;overflow:hidden}.po-scan-bar i{display:block;height:100%;width:18%;background:linear-gradient(90deg,#3d8bff,#1ee687);animation:poScanBar 1.3s ease-in-out infinite}@keyframes poScanBeam{to{left:110%}}@keyframes poScanBar{0%{transform:translateX(-120%)}100%{transform:translateX(560%)}}';
      document.head.appendChild(style);
    }
    var ov = document.createElement('div');
    ov.className = 'po-scan-overlay';
    ov.id = 'po-scan-overlay';
    ov.innerHTML = '<div class="po-scan-beam"></div><div class="po-scan-copy"><div class="po-scan-title">СКАНИРОВАНИЕ</div><div class="po-scan-sub" id="po-scan-sub">Считываю график Pocket Option…</div><div class="po-scan-bar"><i></i></div></div>';
    $('po-chart-wrap').appendChild(ov);
  }

  function setScanOverlay(on, text) {
    ensureScanOverlay();
    var ov = $('po-scan-overlay');
    var sub = $('po-scan-sub');
    if (sub && text) sub.textContent = text;
    if (ov) ov.classList.toggle('active', !!on);
  }

  function startNextCandleClock(tf) {
    if (scanExpiryTimer) clearInterval(scanExpiryTimer);
    var tick = function () {
      var el = $('scanning-expiry');
      if (!el) return;
      var msTf = Math.max(1, Number(tf || 1)) * 60000;
      var sec = Math.max(0, Math.ceil((msTf - (Date.now() % msTf)) / 1000));
      var mm = String(Math.floor(sec / 60)).padStart(2, '0');
      var ss = String(sec % 60).padStart(2, '0');
      el.textContent = 'NEXT M' + (tf || 1) + '  ' + mm + ':' + ss;
    };
    tick();
    scanExpiryTimer = setInterval(tick, 250);
  }

  function readJournal() {
    try { return JSON.parse(localStorage.getItem('vip_signal_log') || '[]'); }
    catch (e) { return []; }
  }

  function writeJournal(rows) {
    try { localStorage.setItem('vip_signal_log', JSON.stringify((rows || []).slice(-500))); }
    catch (e) {}
  }

  function postJournal(row) {
    var base = apiBase();
    if (!base || !row) return;
    fetch(base + '/api/signals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row)
    }).catch(function () {});
  }

  function rememberSignal(pair, tf, analysis) {
    if (!analysis) return;
    var signalTimestamp = Number(analysis.quoteAt || Date.now());
    var expirationTimestamp = signalTimestamp + 60000;
    var id = String(pair || '') + ':' + tf + ':' + signalTimestamp;
    var log = readJournal();
    if (log.some(function (row) { return row.id === id; })) return;
    var row = {
      id: id,
      at: Date.now(),
      signalTimestamp: signalTimestamp,
      pair: pair,
      tf: Number(tf) || 1,
      entryAt: signalTimestamp,
      expiryAt: expirationTimestamp,
      expirationTimestamp: expirationTimestamp,
      receivedAt: analysis.receivedAt || 0,
      signalAt: analysis.signalAt || Date.now(),
      latencyMs: analysis.latencyMs || 0,
      signal: analysis.isUp ? 'UP' : 'DOWN',
      marketState: analysis.marketState || '',
      score: analysis.score,
      dataAge: analysis.dataAge,
      entry: analysis.wait ? null : (analysis.entry || analysis.last || null),
      close: null,
      result: null,
      up: analysis.up,
      down: analysis.down,
      indicators: analysis.indicators || null,
      reason: analysis.reason || ''
    };
    log.push(row);
    writeJournal(log);
    postJournal(row);
  }

  function gradeJournal(candles, ticks) {
    if (!window.SignalEngine || !window.SignalEngine.resolveOutcome) return;
    var log = readJournal();
    var changed = false;
    log.forEach(function (row) {
      if (!row || row.signal === 'NO_TRADE') return;
      var before = row.result;
      var keptEntry = row.entry;
      window.SignalEngine.resolveOutcome(row, { ticks: ticks || [], candles: candles, now: Date.now() });
      if (keptEntry > 0) row.entry = keptEntry;
      if (row.result && row.result !== before) {
        changed = true;
        postJournal(row);
      }
    });
    if (changed) writeJournal(log);
  }

  function journalLine() {
    var done = readJournal().filter(function (row) { return row.result === 'WIN' || row.result === 'LOSS'; });
    if (!done.length) return '';
    var wins = done.filter(function (row) { return row.result === 'WIN'; }).length;
    return 'Журнал: ' + done.length + ' закрытых сигналов, ' + wins + ' свеча закрылась в сторону сигнала.';
  }

  function paintVerdict(pair, tfLabel, analysis) {
    var d = digitsFor(analysis.entry || analysis.last || 0);
    var entry = (analysis.entry || analysis.last || 0).toFixed(d);
    var title = $('analyzed-pair-title');
    if (title) title.textContent = pair + '  •  ' + tfLabel;
    var label = $('ta-summary-tf-label');
    if (label) label.textContent = (analysis.marketState || 'РЫНОК') + ' · ' + tfLabel;
    var ind = analysis.indicators || {};
    var rsiEl = $('ta-rsi-val');
    if (rsiEl) rsiEl.textContent = Number(ind.rsi != null ? ind.rsi : analysis.rsi || 0).toFixed(1);
    var s9 = $('ta-sma9-val');
    if (s9) s9.textContent = Number(ind.ema20 != null ? ind.ema20 : analysis.sma9 || 0).toFixed(d);
    var s20 = $('ta-sma20-val');
    if (s20) s20.textContent = Number(ind.ema50 != null ? ind.ema50 : analysis.sma20 || 0).toFixed(d);
    var vol = $('ta-vol-val');
    if (vol) vol.textContent = ind.adx != null ? Number(ind.adx).toFixed(1) : Number(analysis.vol || 0).toFixed(2) + '%';
    var arrow = $('final-direction-arrow');
    var fill = $('final-progress-fill');
    var acc = $('final-accuracy-percent');
    var verdict = $('ta-verdict-box');
    if (acc) acc.textContent = (analysis.score != null ? analysis.score : analysis.accuracy) + '/100';
    if (fill) fill.style.width = Math.max(0, Math.min(100, analysis.score != null ? analysis.score : analysis.accuracy)) + '%';
    if (analysis.wait) {
      if (arrow) { arrow.textContent = 'CALL ↑'; arrow.className = 'final-dir up'; arrow.style.color = ''; }
      if (fill) { fill.style.background = 'var(--neon-green)'; fill.style.boxShadow = '0 0 20px var(--neon-green)'; }
      if (verdict) { verdict.textContent = 'CALL · ' + (analysis.reason || 'коррекция по Фибоначчи'); verdict.className = 'ta-verdict buy'; }
    } else if (analysis.isUp) {
      if (arrow) { arrow.textContent = 'CALL ↑ СЛЕДУЮЩАЯ M' + scanTf; arrow.className = 'final-dir up'; arrow.style.color = ''; }
      if (fill) { fill.style.background = 'var(--neon-green)'; fill.style.boxShadow = '0 0 20px var(--neon-green)'; }
      if (verdict) { verdict.textContent = 'CALL · вверх ' + (analysis.up == null ? '' : analysis.up + '/10 · ') + 'вход от ' + entry + ' · ' + tfLabel; verdict.className = 'ta-verdict buy'; }
    } else {
      if (arrow) { arrow.textContent = 'PUT ↓ СЛЕДУЮЩАЯ M' + scanTf; arrow.className = 'final-dir down'; arrow.style.color = ''; }
      if (fill) { fill.style.background = 'var(--neon-red)'; fill.style.boxShadow = '0 0 20px var(--neon-red)'; }
      if (verdict) { verdict.textContent = 'PUT · вниз ' + (analysis.down == null ? '' : analysis.down + '/10 · ') + 'вход от ' + entry + ' · ' + tfLabel; verdict.className = 'ta-verdict sell'; }
    }
    var banner = $('scan-pattern-banner');
    if (banner) {
      var journal = journalLine();
      var barLine = lastBarLine(analysis.lastBar);
      var lag = analysis.latencyMs != null ? ('SIGNAL LATENCY: ' + analysis.latencyMs + ' ms') : '';
      banner.innerHTML = (barLine ? barLine + '<br>' : '') + (lag ? lag + '<br>' : '') + (analysis.reasons || []).join('<br>') + (journal ? '<br>' + journal : '');
    }
    var call = $('scan-call-side');
    var put = $('scan-put-side');
    if (call && put) {
      call.classList.toggle('active-call', analysis.wait || analysis.isUp);
      put.classList.toggle('active-put', !analysis.wait && !analysis.isUp);
      call.style.opacity = analysis.wait || analysis.isUp ? '1' : '0.45';
      put.style.opacity = !analysis.wait && !analysis.isUp ? '1' : '0.45';
    }
    var price = $('scanning-live-price');
    if (price && analysis.last) {
      price.textContent = analysis.last.toFixed(digitsFor(analysis.last));
      price.className = 'po-price ' + (analysis.isUp || analysis.wait ? '' : 'down');
    }
    window.__slvChatContext = {
      pair: pair,
      price: analysis.last,
      reason: (analysis.reasons && analysis.reasons[0]) || '',
      rsi: analysis.rsi,
      closes: analysis.closes || [],
      direction: analysis.isUp || analysis.wait ? 'CALL' : 'PUT',
      level: analysis.fib ? analysis.fib.nearest : null,
      points: analysis.pointsText || '',
      up: analysis.up,
      down: analysis.down,
      modelStrength: analysis.confidence
    };
  }

  var forecastToken = 0;
  function lastBarLine(bar) {
    if (!bar || !(bar.close > 0)) return '';
    var stamp = '';
    if (bar.t) {
      try {
        stamp = new Date(bar.t).toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
      } catch (e) { stamp = ''; }
    }
    var d = digitsFor(bar.close);
    return 'Свеча M1 ' + (stamp ? stamp + ' МСК' : '') + ' O ' + bar.open.toFixed(d) + ' H ' + bar.high.toFixed(d) + ' L ' + bar.low.toFixed(d) + ' C ' + bar.close.toFixed(d) + '. RSI считается по этим же свечам.';
  }

  function askScannerForecast() {
    window.__slvForecast = null;
  }

  function stopScanTimers() {
    if (scanPriceTimer) { clearInterval(scanPriceTimer); scanPriceTimer = null; }
    if (scanExpiryTimer) { clearInterval(scanExpiryTimer); scanExpiryTimer = null; }
    setScanOverlay(false);
  }

  function wire() {
    if (wired || typeof window.filterAnalysisPairs !== 'function' || typeof window.switchScreen !== 'function') return false;
    wired = true;
    var origFilter = window.filterAnalysisPairs;
    var origSetCat = window.setAssetCategory;
    var origSetTf = window.setScanTimeframe;
    var origClose = window.closeFullscreenAnalysis;
    var origSwitch = window.switchScreen;

    window.setAssetCategory = function (category) {
      scanCategory = category || 'forex';
      if (typeof origSetCat === 'function') return origSetCat.apply(this, arguments);
    };
    window.setScanTimeframe = function (mins) {
      scanTf = Number(mins) || 1;
      if (typeof origSetTf === 'function') return origSetTf.apply(this, arguments);
    };
    window.filterAnalysisPairs = function () {
      if (liveCats) return renderLivePairs();
      return origFilter.apply(this, arguments);
    };
    window.switchScreen = function (id) {
      if (typeof origSwitch === 'function') origSwitch.apply(this, arguments);
      if (id === 'bot-analysis-screen') refreshPocketPairs();
      if (!window.__slvPayoutTimer) {
        window.__slvPayoutTimer = setInterval(function () {
          var screen = document.getElementById('bot-analysis-screen');
          if (screen && screen.classList.contains('active')) refreshPocketPairs();
        }, 20000);
      }
    };
    window.closeFullscreenAnalysis = function () {
      stopScanTimers();
      if (typeof origClose === 'function') return origClose.apply(this, arguments);
    };

    window.launchFullscreenAnalysis = async function (pairName) {
      var tf = scanTf || 1;
      var tfLabel = 'M' + tf;
      stopScanTimers();
      var overlay = $('fullscreen-radar');
      var statusText = $('radar-status-text');
      var finalBlock = $('radar-final-result');
      var radarAnim = $('radar-animation-element');
      var marketView = $('scanning-market-view');
      if (!overlay) return;
      window.__slvForecast = null;
      unlockScanScroll(overlay);
      if (radarAnim) radarAnim.style.display = 'none';
      if (marketView) marketView.style.display = 'block';
      if (finalBlock) finalBlock.style.display = 'none';
      if ($('scanning-pair-name')) $('scanning-pair-name').textContent = pairName;
      if ($('scanning-tf-label')) $('scanning-tf-label').textContent = tfLabel + ' • LIVE';
      var otc = $('scanning-otc-badge');
      if (otc) otc.style.display = /OTC/i.test(pairName) ? 'inline-flex' : 'none';
      var price = $('scanning-live-price');
      if (price) { price.textContent = 'ID'; price.className = 'po-price neutral'; }
      var chg = $('scanning-price-change');
      if (chg) { chg.textContent = 'BID'; chg.style.color = '#3d8bff'; }
      if (statusText) statusText.textContent = 'СКАНИРОВАНИЕ ' + tfLabel + '…';
      setScanOverlay(true, 'Считываю график ' + pairName + ' как на Pocket Option…');
      startNextCandleClock(tf);
      try {
        var loaded = await loadScan(pairName, tf);
        var pack = loaded.pack;
        var fromPocket = isPocketHistory(pack.candles, pack.source);
        var raw = analyzeMarket(pack.candles, pack.ticks, loaded.m5, loaded.frames, { quoteAt: pack.quoteAt, receivedAt: pack.receivedAt });
        var analysis = presentSignal(pairName, tf, raw);
        if (fromPocket) {
          gradeJournal(pack.candles, pack.ticks);
          rememberSignal(pairName, tf, analysis);
        }
        drawPocketChart(pack.candles, analysis);
        setTimeout(function () {
          setScanOverlay(false);
          if (finalBlock) finalBlock.style.display = 'block';
          paintVerdict(pairName, tfLabel, analysis);
          if (fromPocket) askScannerForecast(pairName, analysis);
          if (statusText) statusText.textContent = fromPocket ? ('POCKET OPTION • ' + tfLabel) : 'НЕТ СЕССИИ POCKET OPTION';
          var banner = $('scan-pattern-banner');
          if (!fromPocket && banner) {
            banner.textContent = 'График не с терминала Pocket Option. История свечей приходит только после подключения сессии (changeSymbol). Запасной ряд не совпадает с OTC-графиком, поэтому свечи не подменяю.';
          }
          unlockScanScroll(overlay);
        }, 1600);
        scanPriceTimer = setInterval(async function () {
          try {
            var freshLoad = await loadScan(pairName, tf);
            var fresh = freshLoad.pack;
            var liveOk = isPocketHistory(fresh.candles, fresh.source);
            var rawLive = analyzeMarket(fresh.candles, fresh.ticks, freshLoad.m5, freshLoad.frames, { quoteAt: fresh.quoteAt, receivedAt: fresh.receivedAt });
            var live = presentSignal(pairName, tf, rawLive);
            if (liveOk) {
              gradeJournal(fresh.candles, fresh.ticks);
              rememberSignal(pairName, tf, live);
            }
            drawPocketChart(fresh.candles, live);
            paintVerdict(pairName, tfLabel, live);
            if (statusText) statusText.textContent = liveOk ? ('POCKET OPTION • ' + tfLabel) : 'НЕТ СЕССИИ POCKET OPTION';
          } catch (err) {}
        }, 2000);
      } catch (e) {
        setScanOverlay(false);
        if (marketView) marketView.style.display = 'block';
        if (finalBlock) finalBlock.style.display = 'block';
        if (statusText) statusText.textContent = 'НЕТ СВЕЧЕЙ POCKET OPTION';
      }
    };
    return true;
  }

  function boot() {
    if (wire()) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (wire() || tries > 40) clearInterval(timer);
    }, 50);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
