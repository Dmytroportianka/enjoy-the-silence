// Agent Factory service worker: carries push notifications to the owner
// even when every dashboard tab is in the background. It deliberately
// does NOT cache the app shell or API responses — the factory state
// changes every few seconds, and a stale board is worse than none.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // Network only: no respondWith, the browser handles every request live.
});
self.addEventListener("push", (event) => {
  let data = {
    title: "Agent Factory",
    body: "A task needs your input",
    taskId: "",
  };
  try {
    data = {
      ...data,
      ...event.data.json(),
    };
  } catch {
    /* keep defaults */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.taskId ? `af-${data.taskId}` : "af",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: {
        taskId: data.taskId ?? "",
      },
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const url = taskId ? `/tasks/${encodeURIComponent(taskId)}` : "/requests";
  event.waitUntil(
    self.clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then((clients) => {
        for (const client of clients) {
          if ("navigate" in client) {
            void client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
