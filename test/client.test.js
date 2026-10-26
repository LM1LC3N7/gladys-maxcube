// -----------------------------------------------------------------------------
// The connection (src/cube/client.js) against a REAL local TCP server playing
// a Cube: the greeting through real sockets (bytes cut anywhere), the
// exchanges, a push, the bounds, the timeouts and the closes. Loopback only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { LIMITS } from '../src/constants.js';
import { CubeConnection, ERROR_KINDS, openConnection, tcpConnect } from '../src/cube/client.js';
import { DOC_H, DOC_S, TRV, WALL, WINDOW, encodeC, encodeL, encodeM } from './fixtures/cube.js';

const GREETING = [
  DOC_H,
  ...encodeM(),
  encodeC(TRV),
  encodeC(WALL),
  encodeC(WINDOW),
  encodeL([[TRV, { target: 20 }]]),
];

/** A server playing a Cube: `script(line, socket)` answers what is written. */
async function cubeServer({ greeting = GREETING, script, chunk } = {}) {
  const server = { sockets: [], received: [], connections: 0 };
  server.net = createServer((socket) => {
    server.connections += 1;
    server.sockets.push(socket);
    socket.on('error', () => {});
    let pending = '';
    socket.on('data', (data) => {
      pending += data.toString('latin1');
      const parts = pending.split('\r\n');
      pending = parts.pop();
      for (const line of parts) {
        server.received.push(line);
        if (line === 'q:') socket.end();
        else script?.(line, socket);
      }
    });
    const text = greeting.map((line) => `${line}\r\n`).join('');
    if (chunk) {
      // Bytes cut in small pieces, written one after the other.
      let i = 0;
      const next = () => {
        if (i >= text.length || socket.destroyed) return;
        socket.write(text.slice(i, i + chunk), 'latin1');
        i += chunk;
        setImmediate(next);
      };
      next();
    } else {
      socket.write(text, 'latin1');
    }
  });
  await new Promise((resolve) => server.net.listen(0, '127.0.0.1', resolve));
  server.address = { host: '127.0.0.1', port: server.net.address().port };
  server.close = () => {
    for (const socket of server.sockets) socket.destroy();
    return new Promise((resolve) => server.net.close(resolve));
  };
  return server;
}

const answerList = (line, socket) => {
  if (line === 'l:') socket.write(`${encodeL([[TRV, { target: 21, valve: 50 }]])}\r\n`);
  if (line.startsWith('s:')) socket.write(`${DOC_S}\r\n`);
};

test('the greeting through real sockets, cut in 7-byte chunks: hello, metadata, configs, list', async () => {
  const server = await cubeServer({ chunk: 7 });
  try {
    const { connection, greeting } = await openConnection(server.address, { timeoutMs: 2000 });
    assert.equal(greeting.hello.serial, 'KEQ0523864');
    assert.equal(greeting.metadata.devices.length, 4);
    assert.equal(greeting.metadata.rooms[0].name, 'Living room');
    assert.equal(greeting.configs.get('0AED69').comfort, 21);
    assert.equal(greeting.list.length, 1);
    assert.equal(greeting.list[0].target, 20);
    assert.equal(connection.closed, false);
    connection.close({ quit: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(server.received, ['q:']);
    assert.equal(server.connections, 1);
  } finally {
    await server.close();
  }
});

test('l: and s: exchanges, one after the other; a push between them', async () => {
  const server = await cubeServer({ script: answerList });
  try {
    const pushes = [];
    const { connection } = await openConnection(server.address, { timeoutMs: 2000 });
    connection.onPush = (entries) => pushes.push(entries);
    const [first, second] = await Promise.all([
      connection.requestList(1000),
      connection.requestList(1000),
    ]);
    assert.equal(first[0].target, 21);
    assert.equal(second[0].valve, 50);
    assert.deepEqual(server.received, ['l:', 'l:']);
    server.sockets[0].write(`${encodeL([[WALL, { target: 19 }]])}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0][0].rfAddress, '0FC380');
    const answer = await connection.send('AARAAAAAB5EAAWY=', 1000);
    assert.deepEqual(answer, { dutyCycle: 0, result: 0, freeSlots: 49 });
    assert.equal(server.received.at(-1), 's:AARAAAAAB5EAAWY=');
    assert.equal(connection.busySince, undefined);
    connection.close();
  } finally {
    await server.close();
  }
});

test('S result 1: REJECTED, marked sent, the connection kept', async () => {
  const server = await cubeServer({
    script: (line, socket) => {
      if (line.startsWith('s:')) socket.write('S:64,1,00\r\n');
    },
  });
  try {
    const { connection } = await openConnection(server.address, { timeoutMs: 2000 });
    await assert.rejects(connection.send('AARAAAAAB5EAAWY=', 1000), (err) => {
      assert.equal(err.kind, ERROR_KINDS.REJECTED);
      assert.equal(err.sent, true);
      assert.deepEqual(err.answer, { dutyCycle: 100, result: 1, freeSlots: 0 });
      return true;
    });
    assert.equal(connection.closed, false);
    connection.close();
  } finally {
    await server.close();
  }
});

test('beforeSend throws: nothing written, marked notSent', async () => {
  const server = await cubeServer({ script: answerList });
  try {
    const { connection } = await openConnection(server.address, { timeoutMs: 2000 });
    await assert.rejects(
      connection.send('AARAAAAAB5EAAWY=', 1000, {
        beforeSend: () => {
          throw new Error('changed');
        },
      }),
      (err) => err.message === 'changed' && err.notSent === true,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(server.received, []);
    connection.close();
  } finally {
    await server.close();
  }
});

test('no answer in time: TIMEOUT, the connection closed; a closed connection refuses, notSent', async () => {
  const server = await cubeServer();
  try {
    const { connection } = await openConnection(server.address, { timeoutMs: 2000 });
    await assert.rejects(connection.requestList(60), (err) => err.kind === ERROR_KINDS.TIMEOUT);
    assert.equal(connection.closed, true);
    await assert.rejects(
      connection.requestList(60),
      (err) => err.kind === ERROR_KINDS.CLOSED && err.notSent === true,
    );
    assert.equal(connection.stalled(0), false);
  } finally {
    await server.close();
  }
});

test('the Cube closes the connection: CLOSED for the exchange in flight', async () => {
  const server = await cubeServer();
  try {
    const { connection } = await openConnection(server.address, { timeoutMs: 2000 });
    const pending = connection.requestList(2000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.sockets[0].destroy();
    await assert.rejects(pending, (err) => err.kind === ERROR_KINDS.CLOSED);
    assert.equal(connection.closed, true);
  } finally {
    await server.close();
  }
});

test('no greeting in time, nothing listening, a greeting that is not a Cube', async () => {
  const silent = await cubeServer({ greeting: [] });
  try {
    await assert.rejects(
      openConnection(silent.address, { timeoutMs: 80 }),
      (err) => err.kind === ERROR_KINDS.TIMEOUT && err.notSent === true,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(silent.sockets[0].destroyed || silent.sockets[0].readableEnded, true);
  } finally {
    await silent.close();
  }
  const closed = await cubeServer();
  const { address } = closed;
  await closed.close();
  await assert.rejects(
    openConnection(address, { timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && err.notSent === true,
  );
  const foreign = await cubeServer({ greeting: ['220 mail.example.org ESMTP', 'L:not base64!'] });
  try {
    await assert.rejects(
      openConnection(foreign.address, { timeoutMs: 500 }),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  } finally {
    await foreign.close();
  }
});

test('bounds: a line too long, too many lines, closes the connection with PROTOCOL', async () => {
  const long = await cubeServer({ greeting: [`X:${'a'.repeat(LIMITS.LINE_BYTES + 10)}`] });
  try {
    await assert.rejects(
      openConnection(long.address, { timeoutMs: 1000 }),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  } finally {
    await long.close();
  }
  const noEnd = await cubeServer({ greeting: [] });
  try {
    const socket = await tcpConnect(noEnd.address, { timeoutMs: 1000 });
    const connection = new CubeConnection(socket);
    const greeting = connection.waitGreeting(1000);
    // A stream without any line end: cut once the limit is passed.
    noEnd.sockets[0].write(Buffer.alloc(LIMITS.LINE_BYTES + 1, 0x41));
    await assert.rejects(greeting, (err) => err.kind === ERROR_KINDS.PROTOCOL);
    assert.equal(connection.closed, true);
  } finally {
    await noEnd.close();
  }
  const many = await cubeServer({
    greeting: Array.from({ length: LIMITS.GREETING_LINES + 1 }, () => 'A:'),
  });
  try {
    await assert.rejects(
      openConnection(many.address, { timeoutMs: 1000 }),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  } finally {
    await many.close();
  }
});

test('a connection object: the fake socket contract (write, destroy, on)', () => {
  const written = [];
  const listeners = {};
  const socket = {
    write: (text) => written.push(text),
    destroy: () => listeners.close?.(),
    on: (event, fn) => {
      listeners[event] = fn;
    },
  };
  const connection = new CubeConnection(socket);
  const greeting = connection.waitGreeting(1000);
  listeners.data(Buffer.from(`${DOC_H}\r\n${encodeM()[0]}\r\n${encodeL([])}\r\n`));
  return greeting.then((g) => {
    assert.equal(g.hello.serial, 'KEQ0523864');
    assert.deepEqual(g.list, []);
    connection.close({ quit: true });
    assert.deepEqual(written, ['q:\r\n']);
    assert.equal(connection.closed, true);
  });
});
