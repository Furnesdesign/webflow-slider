/**
 * Webflow Slider
 * Version: 1.0.0  (https://github.com/Furnesdesign/webflow-slider)
 * Drag / swipe / arrow / trackpad slider for Webflow (CMS) lists.
 *
 * Attribute Reference:
 * --------------------
 * Wrapper:        slider="wrapper"     (one per slider, can have many per page)
 * List:           slider="list"        (the visible area – the last item stops at its right edge)
 * Items:          slider="item"
 * Prev button:    slider-nav="left"    (optional)
 * Next button:    slider-nav="right"   (optional)
 *
 * Optional settings (on the wrapper):
 * slider-end="item"     Old behaviour: let the last item scroll all the way to the left edge.
 *                       Default ("container"): stop when the last item reaches the right edge.
 *
 * State attributes set by the script (useful for styling in Webflow custom CSS):
 * [slider-nav][data-slider-disabled="true"]   Nav button has nowhere to go
 * [slider="wrapper"][data-slider-static="true"] All items fit – nothing to slide
 * [slider="list"][data-slider-dragging="true"]  Currently dragging
 *
 * JS API:
 * window.FurnesSlider.init()   Initialise sliders added after page load (safe to call again)
 */

(function () {
  'use strict';

  if (window.FurnesSlider) return; // Script included twice – do nothing.

  const SELECTORS = {
    wrapper: '[slider="wrapper"]',
    list: '[slider="list"]',
    item: '[slider="item"]',
    navLeft: '[slider-nav="left"]',
    navRight: '[slider-nav="right"]'
  };

  const SETTINGS = {
    easing: 0.1,            // Share of remaining distance moved per 60fps frame
    edgeResistance: 0.25,   // Drag resistance past first/last position
    axisLockThreshold: 4,   // px before deciding horizontal vs vertical drag
    dragClickThreshold: 5,  // px of drag that cancels link clicks
    swipeThreshold: 50,     // px swipe that always moves at least one slide
    flickProjection: 180,   // ms of velocity projected forward on release
    wheelSnapDelay: 140     // ms after last trackpad event before snapping
  };

  const CSS = `
    [slider="wrapper"] [slider="list"] {
      overflow: visible !important;
      will-change: transform;
      touch-action: pan-y pinch-zoom;
      user-select: none;
      -webkit-user-select: none;
      cursor: grab;
    }
    [slider="wrapper"][data-slider-static="true"] [slider="list"] {
      cursor: auto;
    }
    [slider="wrapper"] [slider="list"][data-slider-dragging="true"] {
      cursor: grabbing;
    }
    [slider="wrapper"] [slider="list"] img {
      -webkit-user-drag: none;
      user-drag: none;
    }
    [slider="wrapper"] [slider-nav] {
      transition: opacity 200ms ease;
      cursor: pointer;
    }
    [slider="wrapper"] [slider-nav][data-slider-disabled="true"] {
      opacity: 0.5 !important;
      pointer-events: none;
      cursor: default;
    }
  `;

  const reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  function injectStyles() {
    if (document.getElementById('furnes-slider-style')) return;
    const style = document.createElement('style');
    style.id = 'furnes-slider-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function createSlider(wrapper) {
    const list = wrapper.querySelector(SELECTORS.list);
    if (!list) return null;

    const navLeft = wrapper.querySelector(SELECTORS.navLeft);
    const navRight = wrapper.querySelector(SELECTORS.navRight);
    const stopAtItem = wrapper.getAttribute('slider-end') === 'item';

    let items = [];
    let snaps = [0];      // Allowed transform positions (0, negative, ...)
    let minX = 0;         // Furthest allowed position (negative)
    let index = 0;        // Current snap index

    let currentX = 0;
    let targetX = 0;
    let animationFrame = null;
    let previousTime = 0;

    const drag = {
      pending: false,
      active: false,
      pointerId: null,
      axis: null,
      startX: 0,
      startY: 0,
      startPosition: 0,
      startIndex: 0,
      lastX: 0,
      lastTime: 0,
      velocity: 0,
      moved: false
    };
    let suppressClick = false;
    let wheelTimer = null;
    let refreshFrame = null;

    /* ---------- Measuring ---------- */

    /*
     * Calculates every allowed position. Item positions are clamped so the
     * last position puts the last item's right edge at the list's right edge,
     * and duplicate positions (items that are already visible at the end)
     * are merged into one. That removes the "empty slots" at the end.
     */
    function measure() {
      items = Array.from(list.querySelectorAll(SELECTORS.item));

      if (!items.length) {
        snaps = [0];
        minX = 0;
        return;
      }

      const origin = items[0].offsetLeft;
      const last = items[items.length - 1];
      const styles = getComputedStyle(list);
      const visibleWidth =
        list.clientWidth -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight);

      const maxOffset = stopAtItem
        ? last.offsetLeft - origin
        : Math.max(0, last.offsetLeft + last.offsetWidth - origin - visibleWidth);

      snaps = [];
      items.forEach(function (item) {
        const offset = Math.min(item.offsetLeft - origin, maxOffset);
        const previous = snaps.length ? -snaps[snaps.length - 1] : -Infinity;

        if (offset - previous > 1) {
          snaps.push(-offset);
        } else if (offset >= maxOffset) {
          snaps[snaps.length - 1] = -offset;
        }
      });

      minX = snaps[snaps.length - 1];
      wrapper.setAttribute('data-slider-static', snaps.length <= 1 ? 'true' : 'false');
    }

    function nearestSnap(position) {
      let nearest = 0;
      let nearestDistance = Infinity;

      snaps.forEach(function (snap, i) {
        const distance = Math.abs(snap - position);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = i;
        }
      });

      return nearest;
    }

    /* ---------- Rendering ---------- */

    function applyTransform() {
      list.style.transform = 'translate3d(' + currentX + 'px, 0, 0)';
    }

    function setDisabled(button, disabled) {
      if (!button) return;
      button.setAttribute('data-slider-disabled', disabled ? 'true' : 'false');
      button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      if (button.tagName === 'BUTTON') button.disabled = disabled;
    }

    function updateNavigation() {
      setDisabled(navLeft, index <= 0);
      setDisabled(navRight, index >= snaps.length - 1);
    }

    /*
     * One continuous animation loop. New clicks only change targetX,
     * so rapid clicks keep moving smoothly instead of restarting.
     */
    function animate(time) {
      const frames = previousTime ? Math.min((time - previousTime) / 16.667, 2) : 1;
      previousTime = time;

      const distance = targetX - currentX;

      if (Math.abs(distance) < 0.15) {
        currentX = targetX;
        applyTransform();
        animationFrame = null;
        previousTime = 0;
        return;
      }

      currentX += distance * (1 - Math.pow(1 - SETTINGS.easing, frames));
      applyTransform();
      animationFrame = requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (reducedMotion.matches) {
        stopAnimation();
        currentX = targetX;
        applyTransform();
        return;
      }
      if (animationFrame !== null) return;
      previousTime = 0;
      animationFrame = requestAnimationFrame(animate);
    }

    function stopAnimation() {
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      previousTime = 0;
    }

    function goTo(newIndex, animated) {
      index = clamp(newIndex, 0, snaps.length - 1);
      targetX = snaps[index];
      updateNavigation();

      if (animated) {
        startAnimation();
      } else {
        stopAnimation();
        currentX = targetX;
        applyTransform();
      }
    }

    function withResistance(position) {
      if (position > 0) return position * SETTINGS.edgeResistance;
      if (position < minX) return minX + (position - minX) * SETTINGS.edgeResistance;
      return position;
    }

    /* ---------- Buttons & keyboard ---------- */

    function bindNav(button, step) {
      if (!button) return;

      // Webflow nav is often a div / link block – make it keyboard accessible.
      if (button.tagName !== 'BUTTON') {
        if (!button.hasAttribute('role')) button.setAttribute('role', 'button');
        if (!button.hasAttribute('tabindex')) button.setAttribute('tabindex', '0');
      }
      if (!button.hasAttribute('aria-label')) {
        button.setAttribute('aria-label', step > 0 ? 'Next slide' : 'Previous slide');
      }

      button.addEventListener('click', function (event) {
        event.preventDefault();
        goTo(index + step, true);
      });

      button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          goTo(index + step, true);
        }
      });
    }

    bindNav(navLeft, -1);
    bindNav(navRight, 1);

    list.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goTo(index + 1, true);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goTo(index - 1, true);
      }
    });

    // Tabbing to a link inside a hidden slide brings that slide into view.
    list.addEventListener('focusin', function (event) {
      if (drag.active) return;
      const item = event.target.closest(SELECTORS.item);
      const itemIndex = items.indexOf(item);
      if (itemIndex < 0) return;

      const itemLeft = currentX + (item.offsetLeft - items[0].offsetLeft);
      const itemRight = itemLeft + item.offsetWidth;
      if (itemLeft >= -1 && itemRight <= list.clientWidth + 1) return; // Already visible

      goTo(nearestSnap(-(item.offsetLeft - items[0].offsetLeft)), true);
    });

    /* ---------- Dragging ---------- */

    list.addEventListener('pointerdown', function (event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (snaps.length <= 1) return;

      drag.pending = true;
      drag.active = false;
      drag.pointerId = event.pointerId;
      drag.axis = null;
      drag.moved = false;
      drag.startX = event.clientX;
      drag.startY = event.clientY;
      drag.lastX = event.clientX;
      drag.lastTime = performance.now();
      drag.velocity = 0;
    });

    list.addEventListener('pointermove', function (event) {
      if (!drag.pending || event.pointerId !== drag.pointerId) return;

      const movementX = event.clientX - drag.startX;
      const movementY = event.clientY - drag.startY;

      if (!drag.axis) {
        if (Math.abs(movementX) > Math.abs(movementY) + SETTINGS.axisLockThreshold) {
          drag.axis = 'horizontal';
        } else if (Math.abs(movementY) > Math.abs(movementX) + SETTINGS.axisLockThreshold) {
          drag.axis = 'vertical';
          drag.pending = false; // Leave vertical movement to page scrolling.
          return;
        } else {
          return;
        }
      }

      if (!drag.active) {
        /*
         * Pointer capture is only taken once a horizontal drag starts.
         * Capturing on pointerdown would redirect clicks away from links
         * inside the slides.
         */
        drag.active = true;
        stopAnimation();
        drag.startPosition = currentX - movementX;
        drag.startIndex = index;
        list.setAttribute('data-slider-dragging', 'true');
        try {
          list.setPointerCapture(event.pointerId);
        } catch (error) {
          /* Pointer capture not available */
        }
      }

      event.preventDefault();

      if (Math.abs(movementX) > SETTINGS.dragClickThreshold) drag.moved = true;

      currentX = withResistance(drag.startPosition + movementX);
      applyTransform();

      const now = performance.now();
      const elapsed = Math.max(now - drag.lastTime, 1);
      const instant = (event.clientX - drag.lastX) / elapsed;
      drag.velocity = drag.velocity * 0.65 + instant * 0.35;
      drag.lastX = event.clientX;
      drag.lastTime = now;

      index = nearestSnap(currentX);
      updateNavigation();
    });

    function finishDrag(event) {
      if (event.pointerId !== drag.pointerId) return;

      const wasActive = drag.active;
      drag.pending = false;
      drag.active = false;
      drag.pointerId = null;

      if (!wasActive) return;

      list.removeAttribute('data-slider-dragging');
      try {
        list.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* Pointer capture was not active */
      }

      // Holding still before releasing should not count as a flick.
      const velocity = performance.now() - drag.lastTime > 80 ? 0 : drag.velocity;
      let newIndex = nearestSnap(currentX + velocity * SETTINGS.flickProjection);

      // A clear swipe always moves at least one slide.
      const totalMovement = currentX - drag.startPosition;
      if (newIndex === drag.startIndex && Math.abs(totalMovement) > SETTINGS.swipeThreshold) {
        newIndex += totalMovement < 0 ? 1 : -1;
      }

      goTo(newIndex, true);

      if (drag.moved) {
        suppressClick = true;
        window.setTimeout(function () {
          suppressClick = false;
        }, 100);
      }
    }

    list.addEventListener('pointerup', finishDrag);
    list.addEventListener('pointercancel', finishDrag);

    // Stop native drag of links / images, which would cancel the swipe.
    list.addEventListener('dragstart', function (event) {
      event.preventDefault();
    });

    // Prevent links in items from opening after a swipe.
    list.addEventListener('click', function (event) {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
    }, true);

    /* ---------- Trackpad / shift + mouse wheel ---------- */

    list.addEventListener('wheel', function (event) {
      if (snaps.length <= 1) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;

      event.preventDefault();
      stopAnimation();

      currentX = clamp(currentX - event.deltaX, minX, 0);
      applyTransform();
      index = nearestSnap(currentX);
      updateNavigation();

      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(function () {
        goTo(nearestSnap(currentX), true);
      }, SETTINGS.wheelSnapDelay);
    }, { passive: false });

    /* ---------- Layout changes ---------- */

    let resizeObserver = null;

    function observeItems() {
      if (!resizeObserver) return;
      items.forEach(function (item) {
        resizeObserver.observe(item);
      });
    }

    function refresh() {
      cancelAnimationFrame(refreshFrame);
      refreshFrame = requestAnimationFrame(function () {
        measure();
        observeItems();

        if (drag.active) return;
        goTo(index, false);
      });
    }

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(refresh);
      resizeObserver.observe(list);
    } else {
      window.addEventListener('resize', refresh);
    }

    // Collection List changes (CMS Load, filtering, pagination etc.)
    new MutationObserver(function (mutations) {
      const changed = mutations.some(function (mutation) {
        return Array.from(mutation.addedNodes)
          .concat(Array.from(mutation.removedNodes))
          .some(function (node) {
            return node.nodeType === 1 &&
              (node.matches(SELECTORS.item) || node.querySelector(SELECTORS.item));
          });
      });
      if (changed) refresh();
    }).observe(list, { childList: true, subtree: true });

    // Images / fonts can change item widths after load.
    if (document.readyState !== 'complete') {
      window.addEventListener('load', refresh, { once: true });
    }

    measure();
    observeItems();
    goTo(0, false);

    return {
      wrapper: wrapper,
      next: function () { goTo(index + 1, true); },
      prev: function () { goTo(index - 1, true); },
      goTo: function (i, animated) { goTo(i, animated !== false); },
      refresh: refresh
    };
  }

  const instances = [];

  function init() {
    const wrappers = document.querySelectorAll(SELECTORS.wrapper);
    if (!wrappers.length) return instances;

    injectStyles();

    wrappers.forEach(function (wrapper) {
      if (wrapper.hasAttribute('data-slider-ready')) return;
      const slider = createSlider(wrapper);
      if (!slider) return;
      wrapper.setAttribute('data-slider-ready', '');
      instances.push(slider);
    });

    return instances;
  }

  window.FurnesSlider = { version: '1.0.0', init: init, instances: instances };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
