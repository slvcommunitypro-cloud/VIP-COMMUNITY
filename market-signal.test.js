'use strict';

const assert = require('assert');
const market = require('./market-signal');

function bars(closes) {
  return closes.map(function (close, index) {
    var prev = index ? closes[index - 1] : close;
    return {
      t: index * 60000,
      open: prev,
      high: Math.max(prev, close) + 0.00002,
      low: Math.min(prev, close) - 0.00002,
      close: close
    };
  });
}

function walk(start, steps) {
  var price = start;
  var closes = [price];
  steps.forEach(function (step) {
    var count = Math.abs(step.count);
    var dir = step.count < 0 ? -1 : 1;
    for (var i = 0; i < count; i++) {
      price += dir * step.size;
      closes.push(Number(price.toFixed(5)));
    }
  });
  return closes;
}

function callOf(closes, ticks) {
  var rows = bars(closes);
  return market.minuteCall(market.fibRetracement(rows), rows, ticks || null);
}

var rally = walk(1.1, [
  { count: -20, size: 0.0003 },
  { count: 20, size: 0.00025 }
]);
var rallyCall = callOf(rally);
assert.strictEqual(rallyCall.wait, false);
assert.strictEqual(rallyCall.isUp, true, 'four green candles must extend up, got ' + rallyCall.reason);
assert.ok(/Продление вверх/.test(rallyCall.reason), rallyCall.reason);

var upThenOneRed = walk(1.08, [{ count: 36, size: 0.00008 }]);
upThenOneRed[upThenOneRed.length - 1] = upThenOneRed[upThenOneRed.length - 2] - 0.00003;
var fadeHigh = callOf(upThenOneRed);
assert.strictEqual(fadeHigh.wait, false);
assert.strictEqual(fadeHigh.isUp, false, 'price at the fib high must correct down, got ' + fadeHigh.reason);
assert.ok(/сверху вниз|Верх Фибоначчи/.test(fadeHigh.reason), fadeHigh.reason);

var downThenOneGreen = walk(1.09, [{ count: -36, size: 0.00008 }]);
downThenOneGreen[downThenOneGreen.length - 1] = downThenOneGreen[downThenOneGreen.length - 2] + 0.00003;
var bounceLow = callOf(downThenOneGreen);
assert.strictEqual(bounceLow.wait, false);
assert.strictEqual(bounceLow.isUp, true, 'price at the fib low must correct up, got ' + bounceLow.reason);
assert.ok(/от низа вверх|Низ Фибоначчи/.test(bounceLow.reason), bounceLow.reason);

var breakHigh = walk(1.05, [{ count: 30, size: 0.0001 }]);
var breakRows = bars(breakHigh);
var breakTicks = [];
for (var i = 0; i < 12; i++) breakTicks.push([i, breakRows[breakRows.length - 1].close + i * 0.00004]);
var breakCall = market.minuteCall(market.fibRetracement(breakRows), breakRows, breakTicks);
assert.strictEqual(breakCall.isUp, true, 'four green candles stay CALL even if ticks push, got ' + breakCall.reason);

var failedBounce = walk(1.2, [
  { count: 24, size: 0.0001 },
  { count: -12, size: 0.00018 }
]);
var failed = callOf(failedBounce);
assert.strictEqual(failed.isUp, false, 'four red candles must extend down, got ' + failed.reason);
assert.ok(/Продление вниз/.test(failed.reason), failed.reason);

var bounce = walk(1.07, [
  { count: 22, size: 0.00012 },
  { count: -6, size: 0.0001 },
  { count: 3, size: 0.00009 }
]);
var bounceCall = callOf(bounce);
assert.strictEqual(bounceCall.wait, false);
assert.ok(bounceCall.isUp === true || bounceCall.isUp === false, 'middle or zone must still be a side');
assert.ok(/Фибо|Продление|Коррекция/.test(bounceCall.reason), bounceCall.reason);

assert.ok(/Фибо|Продление|Коррекция/.test(rallyCall.reason), rallyCall.reason);
assert.ok(/пт/.test(rallyCall.reason), rallyCall.reason);
assert.ok(rallyCall.reason.indexOf('CALL') >= 0, rallyCall.reason);
assert.ok(bounceLow.reason.indexOf('CALL') >= 0, bounceLow.reason);
assert.ok(fadeHigh.reason.indexOf('PUT') >= 0, fadeHigh.reason);

var upCount = 0;
var downCount = 0;
[rallyCall, fadeHigh, bounceLow, breakCall, failed, bounceCall].forEach(function (row) {
  assert.strictEqual(row.wait, false, row.reason);
  if (row.isUp) upCount += 1;
  else downCount += 1;
});
assert.ok(upCount >= 2 && downCount >= 2, 'signals collapsed to one side: ' + upCount + ' CALL / ' + downCount + ' PUT');

var flickerRows = bars(rally);
var flickerFib = market.fibRetracement(flickerRows);
var ticksUp = [];
var ticksDown = [];
for (var n = 0; n < 20; n++) {
  ticksUp.push([n, flickerRows[flickerRows.length - 1].close + n * 0.00005]);
  ticksDown.push([n, flickerRows[flickerRows.length - 1].close - n * 0.00005]);
}
var fromUpTicks = market.minuteCall(flickerFib, flickerRows, ticksUp);
var fromDownTicks = market.minuteCall(flickerFib, flickerRows, ticksDown);
assert.strictEqual(fromUpTicks.isUp, fromDownTicks.isUp, 'live ticks must not flip the minute direction');
assert.strictEqual(fromUpTicks.isUp, rallyCall.isUp);

function freeze(previous, key, next) {
  if (!previous || previous.key !== key || (previous.analysis.wait && !next.wait)) {
    previous = { key: key, analysis: next };
  }
  return {
    state: previous,
    isUp: previous.analysis.isUp,
    last: next.last
  };
}
var first = { isUp: true, wait: false, last: 1.1 };
var flipped = { isUp: false, wait: false, last: 1.2 };
var held = freeze(null, 'EUR:1', first);
var again = freeze(held.state, 'EUR:1', flipped);
assert.strictEqual(again.isUp, true, 'direction must stay put inside the same minute');
assert.strictEqual(again.last, 1.2, 'live price still updates');
var nextMinute = freeze(again.state, 'EUR:2', flipped);
assert.strictEqual(nextMinute.isUp, false, 'a new minute gets a new direction');

function trendBars(count, start, step) {
  var rows = [];
  var price = start;
  for (var i = 0; i < count; i++) {
    var open = price;
    price = Number((price + step).toFixed(5));
    rows.push({
      t: i * 60000,
      open: open,
      high: Math.max(open, price) + Math.abs(step) * 0.35,
      low: Math.min(open, price) - Math.abs(step) * 0.15,
      close: price
    });
  }
  return rows;
}

function flatBars(count) {
  var rows = [];
  var price = 1.2;
  for (var i = 0; i < count; i++) {
    var open = price;
    var close = Number((1.2 + Math.sin(i / 2) * 0.00004).toFixed(5));
    price = close;
    rows.push({
      t: i * 60000,
      open: open,
      high: Math.max(open, close) + 0.00001,
      low: Math.min(open, close) - 0.00001,
      close: close
    });
  }
  return rows;
}

var upBoard = market.scoreBoard(trendBars(160, 1.1, 0.00012), trendBars(80, 1.1, 0.0004));
assert.strictEqual(upBoard.wait, false, 'clear uptrend should signal, got ' + upBoard.reason);
assert.strictEqual(upBoard.isUp, true, upBoard.reason);
assert.ok(upBoard.up >= 6 && upBoard.up - upBoard.down >= 3, JSON.stringify({ up: upBoard.up, down: upBoard.down, reason: upBoard.reason }));
assert.strictEqual(upBoard.confidence, Math.round(Math.max(upBoard.up, upBoard.down) / 10 * 100));
assert.ok(upBoard.reason.indexOf('не вероятность') >= 0, upBoard.reason);

var downBoard = market.scoreBoard(trendBars(160, 1.3, -0.00012), trendBars(80, 1.3, -0.0004));
assert.strictEqual(downBoard.wait, false, downBoard.reason);
assert.strictEqual(downBoard.isUp, false, downBoard.reason);

var flatBoard = market.scoreBoard(flatBars(160), null);
assert.strictEqual(flatBoard.wait, true, 'flat market must wait, got ' + flatBoard.reason);

var conflict = market.scoreBoard(trendBars(160, 1.1, 0.00012), trendBars(80, 1.2, -0.0005));
assert.strictEqual(conflict.isUp, true, 'clear M1 rise follows the minute even if M5 is still down, got ' + conflict.reason);
assert.strictEqual(conflict.wait, false, conflict.reason);

function rallyThenDump() {
  var rows = trendBars(120, 2.0, 0.00008);
  var last = rows[rows.length - 1].close;
  var spike = rows[rows.length - 1].high + 0.00025;
  for (var i = 0; i < 8; i++) {
    var open = last;
    var close = Number((open - 0.00022).toFixed(5));
    rows.push({
      t: rows.length * 60000,
      open: open,
      high: i === 0 ? spike : Math.max(open, close) + 0.00003,
      low: close - 0.00003,
      close: close
    });
    last = close;
  }
  return rows;
}
var dumped = market.scoreBoard(rallyThenDump(), trendBars(80, 2.0, 0.0003));
assert.strictEqual(dumped.wait, false, dumped.reason);
assert.strictEqual(dumped.isUp, false, 'fall after a rally must be PUT, got ' + dumped.reason);
assert.ok(dumped.down > dumped.up, dumped.reason);

function lateAveragesStillUp() {
  var rows = trendBars(160, 2.0, 0.00005);
  var last = rows[rows.length - 1].close;
  for (var i = 0; i < 6; i++) {
    var open = last;
    var close = Number((open - 0.00009).toFixed(5));
    rows.push({
      t: rows.length * 60000,
      open: open,
      high: Math.max(open, close) + 0.00002,
      low: close - 0.00002,
      close: close
    });
    last = close;
  }
  return rows;
}
var late = market.scoreBoard(lateAveragesStillUp(), trendBars(80, 2.0, 0.0002));
assert.strictEqual(late.isUp, false, 'lagging EMA must not call UP while minutes close down, got ' + late.reason);
assert.strictEqual(late.wait, false, late.reason);

function dumpThenReclaim() {
  var rows = trendBars(90, 1.08, -0.00015);
  var last = rows[rows.length - 1].close;
  for (var i = 0; i < 2; i++) {
    var open = last;
    var close = Number((open + 0.0045).toFixed(5));
    rows.push({
      t: rows.length * 60000,
      open: open,
      high: close + 0.0002,
      low: open - 0.00005,
      close: close
    });
    last = close;
  }
  return rows;
}
var bounced = market.scoreBoard(dumpThenReclaim(), trendBars(80, 1.08, -0.0004));
assert.strictEqual(bounced.wait, false, bounced.reason);
assert.strictEqual(bounced.isUp, true, 'price back above both averages must not stay PUT, got ' + bounced.reason);

function stallAtLow() {
  var rows = trendBars(80, 110, -0.02);
  var last = rows[rows.length - 1];
  last.close = last.open;
  last.high = last.open + 0.004;
  last.low = last.open - 0.004;
  return rows;
}
var stalled = market.scoreBoard(stallAtLow(), trendBars(60, 110, -0.05));
assert.strictEqual(stalled.wait, false, stalled.reason);
assert.strictEqual(stalled.isUp, true, 'RSI at the low with a doji must not stay PUT, got ' + stalled.reason);

function stallAtHigh() {
  var rows = trendBars(80, 1.2, 0.0002);
  var last = rows[rows.length - 1];
  last.close = last.open;
  last.high = last.open + 0.00005;
  last.low = last.open - 0.00005;
  return rows;
}
var topped = market.scoreBoard(stallAtHigh(), trendBars(60, 1.2, 0.0005));
assert.strictEqual(topped.wait, false, topped.reason);
assert.strictEqual(topped.isUp, false, 'RSI at the high with a doji must not stay CALL, got ' + topped.reason);

var graded = market.gradeSignal({
  signal: 'UP',
  entryAt: 60000,
  expiryAt: 120000,
  entry: null,
  result: null
}, [{ t: 60000, open: 1.1, high: 1.2, low: 1.1, close: 1.15 }]);
graded.expiryAt = Date.now() - 1000;
market.gradeSignal(graded, [{ t: 60000, open: 1.1, high: 1.2, low: 1.1, close: 1.15 }]);
assert.strictEqual(graded.result, 'WIN');

function stamped(start, step, count, every) {
  var rows = [];
  var price = start;
  for (var i = 0; i < count; i++) {
    var open = price;
    price = Number((price + step).toFixed(5));
    rows.push({
      t: i * every,
      open: open,
      high: Math.max(open, price) + Math.abs(step) * 0.2,
      low: Math.min(open, price) - Math.abs(step) * 0.1,
      close: price
    });
  }
  return rows;
}
var s5 = stamped(1.1, 0.0001, 40, 5000);
var s15 = market.aggregateCandles(s5, 15000);
assert.ok(s15.length >= 10 && s15.length < s5.length, '15s bars should be grouped from 5s');
assert.strictEqual(s15[0].open, s5[0].open);
assert.strictEqual(s15[s15.length - 1].close, s5[s5.length - 1].close);

var rising = {
  '5с': stamped(1.1, 0.0001, 20, 5000),
  '15с': stamped(1.1, 0.0002, 20, 15000),
  '30с': stamped(1.1, 0.0003, 20, 30000),
  '1м': stamped(1.1, 0.0004, 20, 60000),
  '15м': stamped(1.2, -0.001, 20, 900000)
};
var stackUp = market.timeframeStack(rising);
assert.strictEqual(stackUp.side, 'UP', stackUp.line);

var falling = {
  '5с': stamped(1.3, -0.0001, 20, 5000),
  '15с': stamped(1.3, -0.0002, 20, 15000),
  '30с': stamped(1.3, -0.0003, 20, 30000),
  '1м': stamped(1.3, -0.0004, 20, 60000),
  '5м': stamped(1.3, -0.001, 20, 300000),
  '15м': stamped(1.3, -0.002, 20, 900000)
};
var stackDown = market.timeframeStack(falling);
assert.strictEqual(stackDown.side, 'DOWN', stackDown.line);
assert.ok(stackDown.line.indexOf('Ближайшая минута вниз') >= 0, stackDown.line);

function hugeGreenAfterRise() {
  var rows = trendBars(40, 1.5, 0.00008);
  var prev = rows[rows.length - 2].close;
  var last = rows[rows.length - 1];
  last.open = prev;
  last.close = prev + 0.0025;
  last.high = last.close + 0.00005;
  last.low = last.open;
  return rows;
}
var chased = market.scoreBoard(hugeGreenAfterRise(), null);
market.settleSignal(chased, hugeGreenAfterRise());
assert.strictEqual(chased.isUp, false, 'an oversized up candle must not stay CALL, got ' + chased.reason);
assert.ok(chased.confidence <= 100, 'confidence must stay within 100, got ' + chased.confidence);

var calm = market.scoreBoard(trendBars(80, 1.2, 0.0001), null);
assert.ok(calm.confidence <= 100);
market.settleSignal(calm, trendBars(80, 1.2, 0.0001));
assert.strictEqual(calm.isUp, true, 'a normal rise without a blow-off candle stays CALL');

console.log('score up', upBoard.up, upBoard.down, upBoard.reason.split('.').slice(0, 2).join('.'));
console.log('score down', downBoard.up, downBoard.down);
console.log('score flat', flatBoard.reason);
console.log('market-signal tests passed');
console.log('rally', rallyCall.isUp, rallyCall.reason);
console.log('fade high', fadeHigh.isUp, fadeHigh.reason);
console.log('bounce low', bounceLow.isUp, bounceLow.reason);
console.log('breakout', breakCall.isUp, breakCall.reason);
console.log('four red', failed.isUp, failed.reason);
console.log('pullback', bounceCall.isUp, bounceCall.zone, bounceCall.reason);
