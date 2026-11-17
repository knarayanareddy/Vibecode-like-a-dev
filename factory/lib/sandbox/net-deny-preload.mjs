/**
 * Preload network-egress guard for the portable `node-permission` sandbox tier.
 *
 * Linux (`oci`, `bwrap`, `linux-ns`) and macOS (`darwin-seatbelt`) deny network
 * egress at the OS kernel layer. On hosts where only Node's `--permission` model
 * is available (for example hosted Windows runners), Node >=22 confines
 * filesystem reads/writes, child processes and workers natively, and this frozen
 * preload denies outbound TCP, TLS, UDP, DNS and `fetch` calls before any socket
 * leaves the process.
 */

import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

import { fileURLToPath } from 'node:url';

const origLstatSync = fs.lstatSync.bind(fs);
const origReadlinkSync = fs.readlinkSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);
const origOpenSync = fs.openSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);
const origReadFileAsync = fs.promises.readFile.bind(fs.promises);
const origOpenAsync = fs.promises.open.bind(fs.promises);
const origWriteFileAsync = fs.promises.writeFile.bind(fs.promises);

function assertNoSymlinkEscape(filePath, mode = 'fs.read') {
  if (typeof filePath !== 'string' && !Buffer.isBuffer(filePath) && !(filePath instanceof URL)) return;
  if (!process.permission?.has) return;
  try {
    const abs = path.resolve(filePath instanceof URL ? fileURLToPath(filePath) : String(filePath));
    // Walk candidate and ancestors inside cwd so both leaf symlinks and Windows
    // directory junctions pointing outside allowed roots are rejected.
    const chain = [];
    let cur = abs;
    while (true) {
      chain.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur || !process.permission.has('fs.read', parent)) break;
      cur = parent;
    }
    for (const seg of chain) {
      let stat;
      try { stat = origLstatSync(seg); } catch { continue; }
      if (stat.isSymbolicLink()) {
        const link = origReadlinkSync(seg);
        const resolved = path.resolve(path.dirname(seg), String(link));
        if (!process.permission.has(mode, resolved)) {
          const err = new Error(`VLD sandbox denied symlink traversal outside allowed roots (${resolved})`);
          err.code = 'ERR_ACCESS_DENIED';
          throw err;
        }
      }
    }
  } catch (err) {
    if (err?.code === 'ERR_ACCESS_DENIED') throw err;
  }
}

fs.readFileSync = function guardedReadFileSync(file, ...rest) {
  assertNoSymlinkEscape(file, 'fs.read');
  return origReadFileSync(file, ...rest);
};
fs.openSync = function guardedOpenSync(file, flags, ...rest) {
  const isWrite = typeof flags === 'string' && /[wa+]/.test(flags);
  assertNoSymlinkEscape(file, isWrite ? 'fs.write' : 'fs.read');
  return origOpenSync(file, flags, ...rest);
};
fs.writeFileSync = function guardedWriteFileSync(file, ...rest) {
  assertNoSymlinkEscape(file, 'fs.write');
  return origWriteFileSync(file, ...rest);
};
fs.promises.readFile = async function guardedReadFile(file, ...rest) {
  assertNoSymlinkEscape(file, 'fs.read');
  return origReadFileAsync(file, ...rest);
};
fs.promises.open = async function guardedOpen(file, flags, ...rest) {
  const isWrite = typeof flags === 'string' && /[wa+]/.test(flags);
  assertNoSymlinkEscape(file, isWrite ? 'fs.write' : 'fs.read');
  return origOpenAsync(file, flags, ...rest);
};
fs.promises.writeFile = async function guardedWriteFile(file, ...rest) {
  assertNoSymlinkEscape(file, 'fs.write');
  return origWriteFileAsync(file, ...rest);
};

function networkDeniedError(surface) {
  const error = new Error(`VLD sandbox denied network egress (${surface})`);
  error.code = 'ERR_SANDBOX_NETWORK_DENIED';
  return error;
}

const denySync = (surface) => function deniedNetworkCall() {
  throw networkDeniedError(surface);
};

net.Socket.prototype.connect = denySync('net.Socket.connect');
net.connect = denySync('net.connect');
net.createConnection = denySync('net.createConnection');
tls.connect = denySync('tls.connect');
http.request = denySync('http.request');
http.get = denySync('http.get');
https.request = denySync('https.request');
https.get = denySync('https.get');
dgram.Socket.prototype.send = denySync('dgram.Socket.send');
dgram.Socket.prototype.connect = denySync('dgram.Socket.connect');
dns.lookup = denySync('dns.lookup');
dns.resolve = denySync('dns.resolve');
if (dns.promises) {
  dns.promises.lookup = async () => { throw networkDeniedError('dns.promises.lookup'); };
  dns.promises.resolve = async () => { throw networkDeniedError('dns.promises.resolve'); };
}
if (typeof globalThis.fetch === 'function') {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => { throw networkDeniedError('fetch'); },
    writable: false,
    configurable: false
  });
}
if (typeof globalThis.WebSocket === 'function') {
  Object.defineProperty(globalThis, 'WebSocket', {
    value: function DeniedWebSocket() { throw networkDeniedError('WebSocket'); },
    writable: false,
    configurable: false
  });
}
