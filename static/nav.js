(function () {
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[href]");
    if (!a || a.hostname !== location.hostname) return;
    if (a.getAttribute("href") === "#") return;
    if (a.pathname === location.pathname) return;

    e.preventDefault();
    document.body.style.opacity = "0";
    setTimeout(function () {
      location.href = a.href;
    }, 150);
  });

  window.addEventListener("pageshow", function () {
    document.body.style.opacity = "1";
  });
})();
