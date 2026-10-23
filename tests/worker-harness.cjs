const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

function loadWorker(connect, additions = {}) {
  const filename = path.join(__dirname, '..', '_worker.js');
  const source = readFileSync(filename, 'utf8')
    .replace("import { connect } from 'cloudflare:sockets';", '')
    .replace('export default {', 'const worker = {');
  const context = vm.createContext({
    connect, URL, Request, Response, TextEncoder, TextDecoder, ReadableStream, WritableStream, Blob,
    Uint8Array, ArrayBuffer, AbortController, setTimeout, clearTimeout,
    crypto: { subtle: { digest: async (algorithm, bytes) => {
      // Workers supports MD5; Node's WebCrypto intentionally does not.
      if (algorithm === 'MD5') return Uint8Array.from(createHash('md5').update(Buffer.from(bytes)).digest()).buffer;
      return globalThis.crypto.subtle.digest(algorithm, bytes);
    } } }, atob, btoa,
    console: { log() {}, error() {}, warn() {} },
    ...additions,
  });
  vm.runInContext(source, context, { filename });
  const read = expression => vm.runInContext(expression, context);
  return {
    handle: read('handleTCPOutBound'), bridge: read('remoteSocketToWS'),
    options: read('getConnectionOptions'), websocketHandler: read('vlessOverWSHandler'),
    getAddresses: read('getAddressesapi'), subscription: read('subAddresses'),
    worker: read('worker'), context,
  };
}

module.exports = { loadWorker };
