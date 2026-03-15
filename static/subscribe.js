(function () {
  var items = document.querySelectorAll("main > ul > li");
  if (!items.length) return;

  var apps = [
    [
      "Apple\u00a0Podcasts",
      function (u) {
        return "podcast://" + u.replace(/^https?:\/\//, "");
      },
    ],
    [
      "Overcast",
      function (u) {
        return "overcast://x-callback-url/add?url=" + encodeURIComponent(u);
      },
    ],
    [
      "Pocket\u00a0Casts",
      function (u) {
        return "pktc://subscribe/" + encodeURIComponent(u);
      },
    ],
    [
      "Castro",
      function (u) {
        return "castro://subscribe/" + encodeURIComponent(u);
      },
    ],
  ];

  items.forEach(function (li) {
    var link = li.querySelector("a");
    if (!link) return;
    var url = link.href;

    var sub = document.createElement("div");
    sub.className = "subscribe";

    var input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = url;
    input.addEventListener("click", function () {
      this.select();
    });
    sub.appendChild(input);

    var nav = document.createElement("nav");
    apps.forEach(function (app) {
      var a = document.createElement("a");
      a.href = app[1](url);
      a.textContent = app[0];
      nav.appendChild(a);
    });
    sub.appendChild(nav);

    var container = li.querySelector("div") || li;
    container.appendChild(sub);
  });
})();
