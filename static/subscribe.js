(function () {
  var apps = [
    ["Copy\u00a0RSS", null],
    [
      "AntennaPod",
      function (u) {
        return "antennapod-subscribe://" + u;
      },
    ],
    // [
    //   "Apple\u00a0Podcasts",
    //   function (u) {
    //     return "podcast://" + u.replace(/^https?:\/\//, "");
    //   },
    // ],
    // [
    //   "Overcast",
    //   function (u) {
    //     return "overcast://x-callback-url/add?url=" + encodeURIComponent(u);
    //   },
    // ],
    // [
    //   "Pocket\u00a0Casts",
    //   function (u) {
    //     return "pktc://subscribe/" + encodeURIComponent(u);
    //   },
    // ],
    // [
    //   "Castro",
    //   function (u) {
    //     return "castro://subscribe/" + encodeURIComponent(u);
    //   },
    // ],
    // [
    //   "Podcast\u00a0Addict",
    //   function (u) {
    //     return "podcastaddict://subscribe/" + encodeURIComponent(u);
    //   },
    // ],
  ];

  document.querySelectorAll("[data-subscribe]").forEach(function (el) {
    var url = el.dataset.href || location.href;
    if (!url) return;

    var small = document.createElement("small");
    small.className = "subscribe";

    apps.forEach(function (app, i) {
      if (i > 0) small.appendChild(document.createTextNode(" \u00b7 "));

      var a = document.createElement("a");

      if (app[1] === null) {
        a.href = "#";
        a.addEventListener("click", function (e) {
          e.preventDefault();
          navigator.clipboard.writeText(url).then(function () {
            a.textContent = "Copied!";
            setTimeout(function () {
              a.textContent = app[0];
            }, 1500);
          });
        });
      } else {
        a.href = app[1](url);
      }

      a.textContent = app[0];
      small.appendChild(a);
    });

    el.replaceWith(small);
  });
})();
