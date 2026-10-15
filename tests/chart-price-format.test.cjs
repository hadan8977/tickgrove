const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../scripts/register-typescript.cjs');
const { formatIndicatorValue } = require('../src/features/chart/valueFormat.ts');
test('small positive and negative indicator values retain meaningful digits instead of displaying zero', () => {
  assert.equal(formatIndicatorValue(0.00012085), '0.00012085');
  assert.equal(formatIndicatorValue(-0.00000012085), '-0.00000012085');
  assert.equal(formatIndicatorValue(1.2085e-23), '1.20850e-23');
});
test('ordinary prices/oscillators keep a compact format and unknown values remain unknown', () => {
  assert.equal(formatIndicatorValue(120.85), '120.85');
  assert.equal(formatIndicatorValue(70.126), '70.13');
  assert.equal(formatIndicatorValue(12345.67), '12,345.67');
  assert.equal(formatIndicatorValue(-0), '0.00');
  for (const value of [undefined, null, NaN, Infinity]) assert.equal(formatIndicatorValue(value), '—');
});
