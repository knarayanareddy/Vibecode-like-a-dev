/**
 * Preload network-egress and symlink-escape guard for the portable
 * `node-permission` sandbox tier (ADR 0011, roadmap 2.2 & P3.2).
 *
 * Linux (`oci`, `bwrap`, `linux-ns`) and macOS (`darwin-seatbelt`) deny network
 * egress at the OS kernel layer. On hosts where only Node's permission model is
 * available (for example hosted Windows runners), Node >=22 confines filesystem
 * reads/writes, child processes and workers natively, and this preload denies
 * all outbound TCP, TLS, UDP, DNS and `fetch` calls — optionally permitting
 * connections ONLY to the single host-managed model broker socket or loopback
 * port captured at startup when brokered egress is explicitly configured.
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

// Capture immutable broker target once before any user script loads.
const ALLOWED_BROKER_SOCKET = typeof process.env.VLD_MODEL_BROKER_SOCKET === 'string' && process.env.VLD_MODEL_BROKER_SOCKET.length > 0
  ? path.resolve(process.env.VLD_MODEL_BROKER_SOCKET)
  : null;
const ALLOWED_BROKER_PORT = typeof process.env.VLD_MODEL_BROKER_PORT === 'string' && /^\d+$/.test(process.env.VLD_MODEL_BROKER_PORT)
  ? Number.parseInt(process.env.VLD_MODEL_BROKER_PORT, 10)
  : null;

const origLstatSync = fs.lstatSync.bind(fs);
const origReadlinkSync = fs.readlinkSync.bind(fs);
const origReadFileSync = fs.readFileSync.bind(fs);
const origOpenSync = fs.openSync.bind(fs);
const origWriteFileSync = fs.writeFileSync.bind(fs);
const origReadFileAsync = fs.promises.readFile.bind(fs.promises);
const origOpenAsync = fs.promises.open.bind(fs.promises);
const origWriteFileAsync = fs.promises.writeFile.bind(fs.promises);

const origSocketConnect = net.Socket.prototype.connect;
const origNetConnect = net.connect.bind(net);
const origNetCreateConnection = net.createConnection.bind(net);
const origHttpRequest = http.request.bind(http);

function assertNoSymlinkEscape(filePath, mode = 'fs.read') {
  if (typeof filePath !== 'string' && !Buffer.isBuffer(filePath) && !(filePath instanceof URL)) return;
  if (!process.permission?.has) return;
  try {
    const abs = path.resolve(filePath instanceof URL ? fileURLToPath(filePath) : String(filePath));
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

function isLoopbackHost(host) {
  return !host || host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function isAllowedBrokerConnectArgs(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (ALLOWED_BROKER_SOCKET) {
    if (typeof first === 'string' && path.resolve(first) === ALLOWED_BROKER_SOCKET) return true;
    if (first && typeof first === 'object') {
      // Depending on the Node release, http internals hand createConnection the
      // raw request options (socketPath + URL path) or a normalized one; accept
      // either shape so only the exact broker socket ever passes.
      const candidate = typeof first.socketPath === 'string' ? first.socketPath
        : (typeof first.path === 'string' && !first.port ? first.path : null);
      if (candidate !== null && path.resolve(candidate) === ALLOWED_BROKER_SOCKET && !first.port) return true;
    }
  }
  if (ALLOWED_BROKER_PORT !== null) {
    if (typeof first === 'number' && first === ALLOWED_BROKER_PORT) {
      return isLoopbackHost(typeof args[1] === 'string' ? args[1] : '127.0.0.1');
    }
    if (first && typeof first === 'object' && Number(first.port) === ALLOWED_BROKER_PORT) {
      return isLoopbackHost(first.host ?? first.hostname ?? '127.0.0.1') && !first.socketPath;
    }
  }
  return false;
}

function isAllowedBrokerHttpArgs(args) {
  const first = args[0];
  const opts = typeof first === 'string' || first instanceof URL ? (args[1] ?? {}) : (first ?? {});
  if (ALLOWED_BROKER_SOCKET && opts && typeof opts.socketPath === 'string') {
    return path.resolve(opts.socketPath) === ALLOWED_BROKER_SOCKET;
  }
  if (ALLOWED_BROKER_PORT !== null) {
    if (typeof first === 'string' || first instanceof URL) {
      try {
        const u = new URL(String(first));
        return u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) === ALLOWED_BROKER_PORT;
      } catch {
        return false;
      }
    }
    if (opts && typeof opts === 'object') {
      const host = opts.hostname ?? opts.host ?? '127.0.0.1';
      return host === '127.0.0.1' && Number(opts.port) === ALLOWED_BROKER_PORT;
    }
  }
  return false;
}

const denySync = (surface) => function deniedNetworkCall() {
  throw networkDeniedError(surface);
};
const denyAsync = (surface) => async function deniedAsyncNetworkCall() {
  throw networkDeniedError(surface);
};

net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  if (isAllowedBrokerConnectArgs(args)) return origSocketConnect.apply(this, args);
  throw networkDeniedError('net.Socket.connect');
};
net.connect = function guardedNetConnect(...args) {
  if (isAllowedBrokerConnectArgs(args)) return origNetConnect(...args);
  throw networkDeniedError('net.connect');
};
net.createConnection = function guardedCreateConnection(...args) {
  if (isAllowedBrokerConnectArgs(args)) return origNetCreateConnection(...args);
  throw networkDeniedError('net.createConnection');
};
http.request = function guardedHttpRequest(...args) {
  if (isAllowedBrokerHttpArgs(args)) return origHttpRequest(...args);
  throw networkDeniedError('http.request');
};
http.get = denySync('http.get');
tls.connect = denySync('tls.connect');
https.request = denySync('https.request');
https.get = denySync('https.get');
dgram.createSocket = denySync('dgram.createSocket');
dns.lookup = denySync('dns.lookup');
dns.resolve = denySync('dns.resolve');
dns.resolve4 = denySync('dns.resolve4');
dns.resolve6 = denySync('dns.resolve6');
if (dns.promises) {
  dns.promises.lookup = denyAsync('dns.promises.lookup');
  dns.promises.resolve = denyAsync('dns.promises.resolve');
}
if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = denyAsync('fetch');
}
if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = denySync('WebSocket');
}
