'use strict';

const assert = require('assert');
const engine = require('./signal-engine');

function trend(count, start, step, every) {
  var rows = [];
  var price = start;
  for (var i = 0; i < count; i++) {
    var open = price;
    price = Number((price + step).toFixed(5));
    rows.push({
      t: 1700000000000 + i * (every || 60000),
      open: open,
      high: Math.max(open, price) + Math.abs(step) * 0.25,
      low: Math.min(open, price) - Math.abs(step) * 0.1,
      close: price
    });
  }
  return rows;
}

function noise(count) {
  var rows = [];
  var price = 1.1;
  for (var i = 0; i < count; i++) {
    var open = price;
    var close = Number((1.1 + Math.sin(i / 3) * 0.00005).toFixed(5));
    price = close;
    rows.push({
      t: 1700000000000 + i * 60000,
      open: open,
      high: Math.max(open, close) + 0.00001,
      low: Math.min(open, close) - 0.00001,
      close: close
    });
  }
  return rows;
}

var up = engine.decide({ pair: 'EUR/USD', m1: trend(120, 1.1, 0.00012), now: 1700000000000 + 120 * 60000, lastTickAt: 1700000000000 + 119 * 60000 + 60000 });
assert.strictEqual(up.direction, 'UP', up.reason);
assert.ok(up.score >= 70 && up.score <= 100, up.score);

var down = engine.decide({ pair: 'EUR/USD', m1: trend(120, 1.2, -0.00012), now: 1700000000000 + 120 * 60000, lastTickAt: 1700000000000 + 120 * 60000 });
assert.strictEqual(down.direction, 'DOWN', down.reason);

var flat = engine.decide({ pair: 'EUR/USD', m1: noise(120), now: 1700000000000 + 120 * 60000, lastTickAt: 1700000000000 + 120 * 60000 });
assert.strictEqual(flat.direction, 'NO_TRADE', flat.reason);

var stale = engine.decide({ pair: 'EUR/USD', m1: trend(120, 1.1, 0.00012), now: 1700000000000 + 120 * 60000 + 180000, lastTickAt: 1700000000000 + 119 * 60000 });
assert.strictEqual(stale.direction, 'NO_TRADE', stale.reason);
assert.ok(stale.reason.indexOf('устарела') >= 0);

var rows = trend(180, 1.08, 0.0001);
var report = engine.backtest(rows, 'EUR/USD');
assert.ok(report.all.winRate === null || (report.all.winRate >= 0 && report.all.winRate <= 100));
assert.ok(report.noTrade >= 0);
var future = rows[100];
var pastOnly = engine.decide({ pair: 'EUR/USD', m1: rows.slice(0, 100), now: future.t, lastTickAt: rows[99].t + 60000 });
assert.ok(pastOnly.direction === 'UP' || pastOnly.direction === 'DOWN' || pastOnly.direction === 'NO_TRADE');

var expiry = 120000;
var callRow = { signal: 'UP', entry: 1.1, expirationTimestamp: expiry, result: null };
engine.resolveOutcome(callRow, {
  now: expiry + 1,
  ticks: [{ t: 90000, price: 1.2 }, { t: 119000, price: 1.05 }, { t: 130000, price: 9 }]
});
assert.strictEqual(callRow.exit, 1.05, 'a tick after expiry must not decide the result');
assert.strictEqual(callRow.result, 'LOSS');
assert.strictEqual(callRow.entry, 1.1);

var putRow = { signal: 'DOWN', entry: 1.1, expirationTimestamp: expiry, result: null };
engine.resolveOutcome(putRow, { now: expiry + 1, ticks: [{ t: 119500, price: 1.05 }] });
assert.strictEqual(putRow.result, 'WIN');

var downTrend = trend(120, 1.2, -0.00012);
var upTicks = [];
for (var n = 0; n < 24; n++) upTicks.push({ t: downTrend[downTrend.length - 1].t + n * 1000, price: 1.05 + n * 0.0002 });
var shifted = engine.decide({
  pair: 'CAD/JPY',
  m1: downTrend,
  now: upTicks[upTicks.length - 1].t,
  lastTickAt: upTicks[upTicks.length - 1].t,
  ticks: upTicks
});
assert.strictEqual(shifted.direction, 'UP', shifted.reason);

console.log('engine tests passed');
console.log('up', up.direction, up.score, up.marketState);
console.log('down', down.direction, down.score, down.marketState);
console.log('flat', flat.direction, flat.reason);
console.log('backtest', JSON.stringify(report));
