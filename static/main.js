/*
  Gridnav - keyboard 2D navigation for grids
  Based on original by Christian Heilmann (c) 2016, MIT license
  Modernized: ES6+, event.code instead of keyCode
*/
const Gridnav = function (listElement) {
  const list = typeof listElement === "string" ? document.querySelector(listElement) : listElement;

  if (!list) {
    throw new Error("Gridnav: list element not found");
  }

  const element = list.getAttribute("data-element") || list.firstElementChild?.firstElementChild?.tagName;
  const amount = list.getAttribute("data-amount") ? +list.getAttribute("data-amount") : null;

  const keyMoves = {
    ArrowRight: 1,
    KeyD: 1,
    ArrowLeft: -1,
    KeyA: -1,
    ArrowUp: amount ? -amount : "up",
    KeyW: amount ? -amount : "up",
    ArrowDown: amount ? amount : "down",
    KeyS: amount ? amount : "down",
  };

  const all = list.querySelectorAll(element);

  const getCard = (el) => el.closest(".card") || el;

  const getCardPosition = (el) => {
    const card = getCard(el);
    return { x: card.offsetLeft, y: card.offsetTop };
  };

  const focusWithScroll = (el) => {
    const card = getCard(el);
    const rect = card.getBoundingClientRect();
    const isAbove = rect.top < 0;
    const isBelow = rect.bottom > window.innerHeight;

    if (!isAbove && !isBelow) {
      el.focus();
      return;
    }

    const block = isBelow ? "end" : "start";
    card.scrollIntoView({ block, behavior: "smooth" });

    if ("onscrollend" in window) {
      window.addEventListener("scrollend", () => el.focus(), { once: true });
    } else {
      setTimeout(() => el.focus(), 300);
    }
  };

  const keynav = (ev) => {
    const target = ev.target;
    if (!target.matches?.(element)) return;

    const move = keyMoves[ev.code];
    if (!move) return;

    let currentIndex = -1;
    for (let i = 0; i < all.length; i++) {
      if (all[i] === target) {
        currentIndex = i;
        break;
      }
    }
    if (currentIndex === -1) return;

    ev.preventDefault();

    if (typeof move === "number") {
      const nextIndex = currentIndex + move;
      if (all[nextIndex]) {
        focusWithScroll(all[nextIndex]);
      }
    } else {
      const pos = getCardPosition(all[currentIndex]);
      const direction = move === "up" ? -1 : 1;
      let i = currentIndex + direction;

      while (all[i]) {
        const targetPos = getCardPosition(all[i]);
        if (targetPos.x === pos.x && targetPos.y !== pos.y) {
          focusWithScroll(all[i]);
          break;
        }
        i += direction;
      }
    }
  };

  list.addEventListener("keydown", keynav);

  return {
    destroy: () => list.removeEventListener("keydown", keynav),
  };
};

(function () {
  "use strict";

  function init() {
    initGridNav();
    initFocusTraps();
  }

  function initGridNav() {
    const grid = document.querySelector(".books-grid");
    if (grid) {
      Gridnav(grid);
    }
  }

  function handleEnterKey(checkbox) {
    return (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event("change"));
    };
  }

  function initFocusTraps() {
    if (!window.focusTrap) return;

    document.querySelectorAll("[data-focus-group]").forEach((popup) => {
      const groupId = popup.getAttribute("data-focus-group");
      const checkbox = document.getElementById("checkbox-" + groupId);
      if (!checkbox) return;

      const trap = window.focusTrap.createFocusTrap(popup, {
        escapeDeactivates: true,
        clickOutsideDeactivates: true,
        onDeactivate: () => {
          checkbox.checked = false;
        },
      });

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          trap.activate();
        } else {
          trap.deactivate();
        }
      });

      checkbox.addEventListener("keydown", handleEnterKey(checkbox));

      const closeLabel = popup.querySelector('[for="checkbox-' + groupId + '"]');
      if (closeLabel) {
        closeLabel.addEventListener("keydown", handleEnterKey(checkbox));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
