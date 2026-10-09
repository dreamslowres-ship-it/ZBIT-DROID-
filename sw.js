/**
 * ZBITDROID Service Worker v5.7
 * - Sirve mini-apps desde IndexedDB bajo /apps/<id>/*
 * - Inyecta el bridge de aislamiento ANTES de que corra el JS de la app
 */
const SYSTEM_CACHE = 'zbitdroid-system-v5.7.3';
// Prefijo derivado del scope del SW (funciona en raíz y en subdirectorios de GitHub Pages)
const SCOPE_PATH = new URL(self.registration.scope).pathname; // ej: / o /repo/
const APP_PREFIX = SCOPE_PATH + 'apps/';
const BRIDGE_FILE = '__zbit_bridge.js';

const SYSTEM_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './lib/jszip.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SYSTEM_CACHE).then((cache) =>
      Promise.all(
        SYSTEM_ASSETS.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] skip cache', url, err))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SYSTEM_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(APP_PREFIX)) {
    event.respondWith(handleAppRequest(url));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((res) => {
          if (res && res.ok && event.request.method === 'GET') {
            const clone = res.clone();
            caches.open(SYSTEM_CACHE).then((c) => c.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match('./index.html') || caches.match(SCOPE_PATH + 'index.html'));
    })
  );
});

async function handleAppRequest(url) {
  try {
    const rest = url.pathname.slice(APP_PREFIX.length);
    const slash = rest.indexOf('/');
    const appId = slash === -1 ? rest : rest.slice(0, slash);
    let filePath = slash === -1 ? 'index.html' : rest.slice(slash + 1);
    if (!filePath || filePath.endsWith('/')) filePath = (filePath || '') + 'index.html';
    filePath = filePath.split('?')[0].split('#')[0];

    // Ruta especial: bridge inyectado
    if (filePath === BRIDGE_FILE) {
      return new Response(bridgeScript(appId), {
        status: 200,
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'X-ZBITDROID': 'bridge',
          'Cache-Control': 'no-store'
        }
      });
    }

    const db = await openDB();
    const tx = db.transaction('files', 'readonly');
    const store = tx.objectStore('files');

    let record = await idbGet(store, appId + ':' + filePath);
    if (!record && !filePath.endsWith('.html')) {
      record = await idbGet(store, appId + ':' + filePath + '/index.html');
    }
    if (!record) record = await idbGet(store, appId + ':./' + filePath);

    if (!record) {
      return new Response(
        '<!DOCTYPE html><html><body style="background:#0c0c0e;color:#9a9aa3;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center"><div><h2 style="color:#f0f0f2">Archivo no encontrado</h2><p>' +
          filePath + '</p></div></body></html>',
        { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    const mime = record.mime || guessMime(filePath);

    // Inyectar bridge en HTML antes de que corra cualquier JS
    if (mime.indexOf('text/html') === 0) {
      let text;
      try {
        text = await record.blob.text();
      } catch (e) {
        return new Response(record.blob, {
          status: 200,
          headers: { 'Content-Type': mime, 'X-ZBITDROID': 'virtual-app', 'Cache-Control': 'no-store' }
        });
      }
      const bridgeUrl = APP_PREFIX + appId + '/' + BRIDGE_FILE;
      const tag = '<script src="' + bridgeUrl + '"></script>';
      let modified;
      if (/<head\b[^>]*>/i.test(text)) {
        modified = text.replace(/<head\b[^>]*>/i, (m) => m + tag);
      } else if (/<html\b[^>]*>/i.test(text)) {
        modified = text.replace(/<html\b[^>]*>/i, (m) => m + '<head>' + tag + '</head>');
      } else {
        modified = tag + text;
      }
      return new Response(modified, {
        status: 200,
        headers: { 'Content-Type': mime, 'X-ZBITDROID': 'virtual-app', 'Cache-Control': 'no-store' }
      });
    }

    return new Response(record.blob, {
      status: 200,
      headers: { 'Content-Type': mime, 'X-ZBITDROID': 'virtual-app', 'Cache-Control': 'no-store' }
    });
  } catch (err) {
    return new Response(
      '<!DOCTYPE html><html><body style="background:#0c0c0e;color:#e63946;font-family:sans-serif;padding:40px"><h2>Error</h2><pre>' +
        String(err.message || err) + '</pre></body></html>',
      { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

/* ── Bridge script generator ── */
function bridgeScript(appId) {
  const prefix = 'zbit_' + appId + '_';
  const lsPrefix = 'zbitls:' + appId + ':';
  return [
    '/* ZBITDROID bridge · appId=' + appId + ' */',
    '(function(){',
    'if(window.__ZBIT_BRIDGE__) return;',
    'window.__ZBIT_BRIDGE__ = true;',
    'var APP_ID = ' + JSON.stringify(appId) + ';',
    'var PREFIX = ' + JSON.stringify(prefix) + ';',
    'var LS_PREFIX = ' + JSON.stringify(lsPrefix) + ';',

    /* Bloqueo de parent/top/frameElement/opener */
    'try {',
    '  var _realParent = window.parent;',
    '  var _realPM = (_realParent && _realParent.postMessage) ? _realParent.postMessage.bind(_realParent) : null;',
    '  var _safeParent = new Proxy({}, {',
    '    get: function(t, p){ if(p === "postMessage" && _realPM) return _realPM; return undefined; },',
    '    set: function(){ return false; }',
    '  });',
    '  try { Object.defineProperty(window, "parent", { get: function(){ return _safeParent; }, configurable: true }); } catch(e){}',
    '  try { Object.defineProperty(window, "top", { get: function(){ return _safeParent; }, configurable: true }); } catch(e){}',
    '  try { Object.defineProperty(window, "frameElement", { get: function(){ return null; }, configurable: true }); } catch(e){}',
    '  try { Object.defineProperty(window, "opener", { get: function(){ return null; }, configurable: true }); } catch(e){}',
    '} catch(e){}',

    /* IndexedDB isolation */
    'try {',
    '  var _idb = window.indexedDB;',
    '  if (_idb) {',
    '    var _open = _idb.open.bind(_idb);',
    '    var _del = _idb.deleteDatabase.bind(_idb);',
    '    _idb.open = function(name, version){ var full = PREFIX + name; return version === undefined ? _open(full) : _open(full, version); };',
    '    _idb.deleteDatabase = function(name){ return _del(PREFIX + name); };',
    '  }',
    '} catch(e){}',

    /* CacheStorage isolation */
    'try {',
    '  if(window.caches){',
    '    var _co = window.caches.open.bind(window.caches);',
    '    window.caches.open = function(name){ return _co(PREFIX + name); };',
    '  }',
    '} catch(e){}',

    /* Service Worker block */
    'try {',
    '  if(navigator.serviceWorker && navigator.serviceWorker.register){',
    '    navigator.serviceWorker.register = function(){ return Promise.reject(new Error("SW bloqueado dentro de mini-apps ZBITDROID")); };',
    '  }',
    '} catch(e){}',

    /* Web Workers block */
    'try {',
    '  if(window.Worker){',
    '    var _OrigWorker = window.Worker;',
    '    window.Worker = function(){ throw new Error("Web Workers deshabilitados en mini-apps ZBITDROID (aislamiento)."); };',
    '    window.Worker.prototype = _OrigWorker.prototype;',
    '  }',
    '  if(window.SharedWorker){ window.SharedWorker = function(){ throw new Error("Shared Workers deshabilitados en mini-apps ZBITDROID."); }; }',
    '} catch(e){}',

    /* localStorage namespacing */
    'try {',
    '  var _store = window.localStorage;',
    '  var _ls = {',
    '    getItem: function(k){ return _store.getItem(LS_PREFIX + k); },',
    '    setItem: function(k, v){ _store.setItem(LS_PREFIX + k, String(v)); },',
    '    removeItem: function(k){ _store.removeItem(LS_PREFIX + k); },',
    '    clear: function(){',
    '      var rm = []; for(var i=0;i<_store.length;i++){ var key=_store.key(i); if(key && key.indexOf(LS_PREFIX)===0) rm.push(key); }',
    '      rm.forEach(function(k){ _store.removeItem(k); });',
    '    },',
    '    key: function(i){',
    '      var keys=[]; for(var j=0;j<_store.length;j++){ var key=_store.key(j); if(key && key.indexOf(LS_PREFIX)===0) keys.push(key.slice(LS_PREFIX.length)); }',
    '      return keys[i] || null;',
    '    },',
    '    get length(){ var n=0; for(var j=0;j<_store.length;j++){ var key=_store.key(j); if(key && key.indexOf(LS_PREFIX)===0) n++; } return n; }',
    '  };',
    '  try { Object.defineProperty(window, "localStorage", { configurable: true, get: function(){ return _ls; } }); } catch(e){}',
    '} catch(e){}',

    /* Message bridge */
    'var pending = new Map();',
    'window.addEventListener("message", function(e){',
    '  if(!e.data || e.data.source !== "zbitdroid") return;',
    '  var p = pending.get(e.data.requestId);',
    '  if(!p) return;',
    '  pending.delete(e.data.requestId);',
    '  if(e.data.type === "zbit:error") p.reject(new Error(e.data.payload.message));',
    '  else p.resolve(e.data.payload);',
    '});',
    'function send(type, payload){',
    '  return new Promise(function(resolve, reject){',
    '    var requestId = Math.random().toString(36).slice(2);',
    '    pending.set(requestId, { resolve: resolve, reject: reject });',
    '    var _pm = _realPM || (window.parent && window.parent.postMessage && window.parent.postMessage.bind(window.parent));',
    '    if (!_pm) { reject(new Error("Bridge sin parent")); return; }',
    '    _pm({ source: "zbitdroid-client", type: type, payload: payload, requestId: requestId, timestamp: Date.now() }, "*");',
    '    setTimeout(function(){ if(pending.has(requestId)){ pending.delete(requestId); reject(new Error("Timeout del bridge")); } }, 15000);',
    '  });',
    '}',
    'window.ZBIT = {',
    '  appId: APP_ID,',
    '  getPermissions: function(){ return send("zbit:get-permissions", {}); },',
    '  requestPermission: function(p){ return send("zbit:request-permission", { permission: p }).then(function(r){ return r.granted; }); },',
    '  call: function(api, method){ var args=Array.prototype.slice.call(arguments,2); return send("zbit:call-api", { api: api, method: method, args: args }).then(function(r){ return r.result; }); },',
    '  geolocation: { getCurrentPosition: function(opts){ return window.ZBIT.call("geolocation","getCurrentPosition",opts); } },',
    '  vibrate: function(p){ return window.ZBIT.call("vibrate","vibrate",p); },',
    '  notify: function(t,o){ return window.ZBIT.call("notification","show",t,o); },',
    '  clipboard: {',
    '    writeText: function(t){ return window.ZBIT.call("clipboard","writeText",t); },',
    '    readText: function(){ return window.ZBIT.call("clipboard","readText"); }',
    '  },',
    '  share: function(d){ return window.ZBIT.call("share","share",d); },',
    '  wakeLock: { request: function(){ return window.ZBIT.call("wakelock","request"); }, release: function(){ return window.ZBIT.call("wakelock","release"); } }',
    '};',
    'try { if (_realPM) _realPM({ source: "zbitdroid-client", type: "zbit:ready", payload: { appId: APP_ID }, requestId: "ready-" + Date.now(), timestamp: Date.now() }, "*"); } catch(e){}',
    'console.log("[ZBITDROID] Bridge activo · appId=", APP_ID, "· storage aislado con prefijo", PREFIX);',
    '})();'
  ].join('\n');
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

let _swDb = null;
let _swDbPromise = null;
function openDB() {
  if (_swDb) return Promise.resolve(_swDb);
  if (_swDbPromise) return _swDbPromise;
  _swDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('ZBITDROID_VFS', 2);
    request.onerror = () => { _swDbPromise = null; reject(request.error); };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { _swDb = null; _swDbPromise = null; };
      db.onversionchange = () => { try { db.close(); } catch (e) {} _swDb = null; _swDbPromise = null; };
      _swDb = db;
      _swDbPromise = null;
      resolve(db);
    };
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        const s = db.createObjectStore('files', { keyPath: 'key' });
        s.createIndex('appId', 'appId', { unique: false });
      }
      if (!db.objectStoreNames.contains('apps')) db.createObjectStore('apps', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('permissions')) db.createObjectStore('permissions', { keyPath: 'appId' });
      if (!db.objectStoreNames.contains('shared')) db.createObjectStore('shared', { keyPath: 'path' });
    };
  });
  return _swDbPromise;
}

function guessMime(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    html:'text/html; charset=utf-8', htm:'text/html; charset=utf-8',
    css:'text/css; charset=utf-8', js:'application/javascript; charset=utf-8',
    mjs:'application/javascript; charset=utf-8', json:'application/json',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif',
    webp:'image/webp', svg:'image/svg+xml', ico:'image/x-icon',
    woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf',
    mp3:'audio/mpeg', wav:'audio/wav', mp4:'video/mp4', webm:'video/webm',
    txt:'text/plain', pdf:'application/pdf'
  };
  return map[ext] || 'application/octet-stream';
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'CLIENTS_CLAIM') self.clients.claim();
  
  // ⬇️ AGREGA ESTO AL FINAL DE TU sw.js ⬇️
self.addEventListener('fetch', (event) => {
  // Handler mínimo requerido por Chrome Android para permitir la instalación.
  // No intercepta nada realmente, solo cumple el requisito de instalabilidad.
  return;
});
