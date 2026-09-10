'use strict';

// Minimal protobuf wire codec. Direct port of GPMC/Core/Protobuf.swift:
// length-delimited fields stay opaque until a known path is read.

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n > 127n) {
    bytes.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return Buffer.from(bytes);
}

function intField(field, value) {
  return Buffer.concat([varint(BigInt(field) << 3n), varint(value)]);
}

function bytesField(field, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(v.length), v]);
}

function stringField(field, value) {
  return bytesField(field, Buffer.from(value, 'utf8'));
}

// Parse top-level fields: returns { [fieldNumber]: Buffer[] } for
// length-delimited fields only (matching the Swift decoder's usage).
function fields(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let index = 0;
  const result = {};
  function read() {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      if (index >= b.length) throw new Error('malformed protobuf');
      const byte = b[index];
      index += 1;
      if (shift === 63n && byte > 1) throw new Error('malformed protobuf');
      value |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) return value;
    }
    throw new Error('malformed protobuf');
  }
  while (index < b.length) {
    const tag = read();
    const fieldNumber = Number(tag >> 3n);
    if (fieldNumber <= 0 || fieldNumber > 536870911) throw new Error('malformed protobuf');
    let length;
    switch (Number(tag & 7n)) {
      case 0: read(); continue; // varint value, not captured
      case 1: length = 8; break;
      case 5: length = 4; break;
      case 2: {
        const n = Number(read());
        if (n > b.length - index) throw new Error('malformed protobuf');
        length = n;
        break;
      }
      default: throw new Error('malformed protobuf');
    }
    if (length > b.length - index) throw new Error('malformed protobuf');
    if (Number(tag & 7n) === 2) {
      (result[fieldNumber] = result[fieldNumber] || []).push(b.subarray(index, index + length));
    }
    index += length;
  }
  return result;
}

// The first varint at `field`. `fields` cannot answer this: it keeps only
// length-delimited values, and the codes worth branching on — starting with
// `google.rpc.Status.code` — are varints.
function numberAt(field, data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let index = 0;
  function read() {
    let value = 0n;
    for (let shift = 0n; shift <= 63n; shift += 7n) {
      if (index >= b.length) throw new Error('malformed protobuf');
      const byte = b[index];
      index += 1;
      if (shift === 63n && byte > 1) throw new Error('malformed protobuf');
      value |= BigInt(byte & 127) << shift;
      if ((byte & 128) === 0) return value;
    }
    throw new Error('malformed protobuf');
  }
  while (index < b.length) {
    const tag = read();
    const fieldNumber = Number(tag >> 3n);
    if (fieldNumber <= 0 || fieldNumber > 536870911) throw new Error('malformed protobuf');
    let length;
    switch (Number(tag & 7n)) {
      case 0:
        if (fieldNumber === field) return read(); // first varint wins
        read(); continue;
      case 1: length = 8; break;
      case 5: length = 4; break;
      case 2: {
        const n = Number(read());
        if (n > b.length - index) throw new Error('malformed protobuf');
        length = n;
        break;
      }
      default: throw new Error('malformed protobuf');
    }
    if (length > b.length - index) throw new Error('malformed protobuf');
    index += length;
  }
  return null;
}

// Walk a path of field numbers and decode the leaf as a non-empty UTF-8 string.
function stringAt(path, data) {
  let current = Buffer.isBuffer(data) ? data : Buffer.from(data);
  for (const field of path) {
    const next = (fields(current)[field] || [])[0];
    if (!next) return null;
    current = next;
  }
  const value = current.toString('utf8');
  return value.length ? value : null;
}

module.exports = { varint, intField, bytesField, stringField, fields, numberAt, stringAt };
