const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lines } = require('../lib/rpc/transport.cjs');

for (const split of [false, true]) {
  test(`oversized multibyte record is rejected ${split ? 'before' : 'with'} its newline`, () => {
    const record = Buffer.from('{"text":"你好"}');
    const received = [];
    const parser = new Lines(line => received.push(line), record.length - 1);
    assert.throws(() => {
      parser.push(split ? record : Buffer.concat([record, Buffer.from('\n')]));
      if (split) parser.push(Buffer.from('\n'));
    }, /RPC record exceeds limit/);
    assert.deepEqual(received, []);
  });
}

for (const fragmented of [false, true]) {
  test(`exact byte-boundary UTF-8 records preserve framing ${fragmented ? 'byte by byte' : 'in one chunk'}`, () => {
    const record = '{"text":"你好😀\u2028\u2029"}';
    const received = [];
    const parser = new Lines(line => received.push(JSON.parse(line)), Buffer.byteLength(record));
    const bytes = Buffer.from(record + '\n' + record + '\n');
    for (const chunk of fragmented ? [...bytes].map(byte => Buffer.from([byte])) : [bytes]) parser.push(chunk);
    assert.deepEqual(received, [{ text: '你好😀\u2028\u2029' }, { text: '你好😀\u2028\u2029' }]);
  });
}

test('each complete record is byte-bounded independently within a chunk', () => {
  const received = [];
  const parser = new Lines(line => received.push(line), 4);
  assert.throws(() => parser.push(Buffer.from('ok\n你好\n')), /RPC record exceeds limit/);
  assert.deepEqual(received, ['ok']);
});

test('CRLF counts CR consistently before stripping it from delivered lines', () => {
  for (const fragmented of [false, true]) {
    const received = [];
    const parser = new Lines(line => received.push(line), 4);
    const bytes = Buffer.from('你\r\n');
    for (const chunk of fragmented ? [...bytes].map(byte => Buffer.from([byte])) : [bytes]) parser.push(chunk);
    assert.deepEqual(received, ['你']);
    const tooSmall = new Lines(() => assert.fail('oversized line delivered'), 3);
    assert.throws(() => {
      for (const chunk of fragmented ? [...bytes].map(byte => Buffer.from([byte])) : [bytes]) tooSmall.push(chunk);
    }, /RPC record exceeds limit/);
  }
});
