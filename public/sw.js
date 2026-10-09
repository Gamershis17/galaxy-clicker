/* Galaxy Clicker service worker — offline shell for PWA install.
 * HTML/CSS/JS: network-first (always fresh, offline fallback).
 * API calls (/api/*): never cached. Images: cache-first. */
'use strict';

var CACHE_NAME = 'galaxy-clicker-v4';
var STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/game.js',
  '/admin.html',
  '/admin.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Never cache API responses — game data must stay fresh.
  if (url.pathname.indexOf('/api/') === 0) return;

  var isCode = /\.(html|css|js)$/.test(url.pathname) || url.pathname === '/';

  event.respondWith(
    isCode
      // NETWORK-FIRST for code: always try live, fall back to cache offline.
      ? fetch(req).then(function (res) {
          if (res && res.ok && url.origin === self.location.origin) {
            var copy = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return caches.match(req, { ignoreSearch: true });
        })
      // CACHE-FIRST for images/fonts: rarely change.
      : caches.match(req, { ignoreSearch: true }).then(function (cached) {
          if (cached) return cached;
          return fetch(req).then(function (res) {
            if (res && res.ok && url.origin === self.location.origin) {
              var copy = res.clone();
              caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
            }
            return res;
          });
        })
  );
});
