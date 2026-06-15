(function (m, e, t, r, i, k, a) {
  m[i] = m[i] || function () {
    (m[i].a = m[i].a || []).push(arguments);
  };
  m[i].l = 1 * new Date();
  for (var j = 0; j < document.scripts.length; j += 1) {
    if (document.scripts[j].src === r) return;
  }
  k = e.createElement(t);
  a = e.getElementsByTagName(t)[0];
  k.async = 1;
  k.src = r;
  a.parentNode.insertBefore(k, a);
})(window, document, "script", "https://mc.webvisor.org/metrika/tag_ww.js?id=109097132", "ym");

ym(109097132, "init", {
  ssr: true,
  webvisor: true,
  trackHash: true,
  clickmap: true,
  ecommerce: "dataLayer",
  accurateTrackBounce: true,
  trackLinks: true
});

try {
  if (sessionStorage.getItem("ym_service_goal_open_library") !== "1") {
    sessionStorage.setItem("ym_service_goal_open_library", "1");
    ym(109097132, "reachGoal", "open_library");
  }
} catch (_) {
  ym(109097132, "reachGoal", "open_library");
}
