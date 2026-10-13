// 最小限のService Worker（PWAとしてインストール可能にするため。キャッシュはしない）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
