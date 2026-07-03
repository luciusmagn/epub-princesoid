const els = {
  openButton: document.querySelector("#open-button"),
  emptyOpenButton: document.querySelector("#empty-open-button"),
  prevButton: document.querySelector("#prev-button"),
  nextButton: document.querySelector("#next-button"),
  reloadButton: document.querySelector("#reload-button"),
  fontSize: document.querySelector("#font-size"),
  pageMargin: document.querySelector("#page-margin"),
  pageMarginValue: document.querySelector("#page-margin-value"),
  readerPreset: document.querySelector("#reader-preset"),
  spreadMode: document.querySelector("#spread-mode"),
  themeMode: document.querySelector("#theme-mode"),
  fileLabel: document.querySelector("#file-label"),
  fileName: document.querySelector("#file-name"),
  fileSize: document.querySelector("#file-size"),
  reloadState: document.querySelector("#reload-state"),
  progressText: document.querySelector("#progress-text"),
  progressBar: document.querySelector("#progress-bar"),
  tocList: document.querySelector("#toc-list"),
  readerShell: document.querySelector(".reader-shell"),
  viewer: document.querySelector("#viewer"),
  emptyState: document.querySelector("#empty-state"),
  dropLayer: document.querySelector("#drop-layer"),
  toast: document.querySelector("#toast")
};

const SETTINGS_VERSION = 2;
const DEFAULT_SETTINGS = {
  fontSize: 100,
  pageMargin: 36,
  preset: "fluid",
  spread: "none",
  theme: "light",
  cfiByPath: {},
  version: SETTINGS_VERSION
};
const THEME_ALIASES = { proof: "light", paper: "light", night: "dark" };
const THEMES = new Set(["light", "dark"]);
const SPREAD_MODES = new Set(["none", "auto", "always"]);
const READER_PRESETS = {
  fluid: { width: null, height: null },
  "kindle-paperwhite": { width: 758, height: 1024 },
  "kindle-oasis": { width: 824, height: 1096 },
  "kobo-clara": { width: 758, height: 1024 },
  "kobo-libra": { width: 842, height: 1120 },
  "apple-books-phone": { width: 390, height: 844 },
  "apple-books-ipad": { width: 820, height: 1180 },
  "boox-palma": { width: 824, height: 1648 },
  "boox-go-6": { width: 1072, height: 1448 },
  "boox-go-7": { width: 1264, height: 1680 },
  "boox-go-103": { width: 1860, height: 2480 },
  "boox-note-air": { width: 1860, height: 2480 }
};
const PAGE_MARGIN_RANGE = { min: 0, max: 96, default: 36 };
const GLYPH_GUARD = { min: 3, ratio: 0.18, max: 8 };

const state = {
  payload: null,
  book: null,
  rendition: null,
  currentCfi: null,
  locationsReady: false,
  settings: loadSettings(),
  opening: false,
  locationGenerationToken: 0,
  viewport: { width: "100%", height: "100%" },
  resizeTimer: 0,
  metricsTimer: 0,
  turning: false,
  wheelDelta: 0,
  wheelTurnAt: 0,
  touchStartY: null
};

syncSettings();
wireUi();
wireErrorReporting();
wirePresetResize();
applyChromeTheme();
applyReaderPreset();
saveSettings();

window.Princeznoid = {
  openFromNative(payload) {
    openPayload(payload, { reason: "open" });
  },
  reloadFromNative(payload) {
    openPayload({ ...state.payload, ...payload }, { reason: "watch", targetCfi: state.currentCfi });
  },
  setDropVisible(visible) {
    els.dropLayer.classList.toggle("visible", Boolean(visible));
  },
  showError(message) {
    showToast(message || "Native error.", "error");
  }
};

function wireUi() {
  els.openButton.addEventListener("click", requestOpenDialog);
  els.emptyOpenButton.addEventListener("click", requestOpenDialog);
  els.prevButton.addEventListener("click", () => turnPage("prev"));
  els.nextButton.addEventListener("click", () => turnPage("next"));
  els.reloadButton.addEventListener("click", () => {
    if (state.payload) {
      openPayload(state.payload, { reason: "manual", targetCfi: state.currentCfi });
    }
  });

  els.fontSize.addEventListener("input", () => {
    state.settings.fontSize = Number(els.fontSize.value);
    saveSettings();
    applyTheme();
  });

  els.pageMargin.addEventListener("input", () => {
    state.settings.pageMargin = normalizePageMargin(els.pageMargin.value);
    syncPageMarginControl();
    saveSettings();
    applyViewerPageMargin();
    installPagedSurface();
    logPageMetrics("margin");
  });

  els.readerPreset.addEventListener("change", () => {
    state.settings.preset = els.readerPreset.value;
    saveSettings();
    applyReaderPreset();
    resizeRendition().catch(reportRendererError);
  });

  els.spreadMode.addEventListener("change", async () => {
    state.settings.spread = els.spreadMode.value;
    saveSettings();
    if (state.rendition) {
      state.rendition.spread(state.settings.spread);
      await state.rendition.display(state.currentCfi || undefined);
    }
  });

  els.themeMode.addEventListener("change", () => {
    state.settings.theme = els.themeMode.value;
    saveSettings();
    applyChromeTheme();
    applyTheme();
  });

  document.addEventListener("keydown", handleReaderKeydown);
  els.viewer.addEventListener("wheel", handleReaderWheel, { passive: false });
  els.viewer.addEventListener("touchstart", handleReaderTouchStart, { passive: true });
  els.viewer.addEventListener("touchend", handleReaderTouchEnd, { passive: false });
}

function handleReaderKeydown(event) {
  const tag = event.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    requestOpenDialog();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r") {
    event.preventDefault();
    els.reloadButton.click();
    return;
  }

  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    adjustFontSize(5);
    return;
  }

  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    adjustFontSize(-5);
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
    event.preventDefault();
    turnPage("prev");
  } else if (
    event.key === "ArrowRight" ||
    event.key === "ArrowDown" ||
    event.key === "PageDown" ||
    event.key === " "
  ) {
    event.preventDefault();
    turnPage("next");
  }
}

function handleReaderWheel(event) {
  if (!currentScrollPager() || event.ctrlKey) return;

  event.preventDefault();
  event.stopPropagation();

  const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  state.wheelDelta += delta;

  const now = Date.now();
  if (now - state.wheelTurnAt < 240 || Math.abs(state.wheelDelta) < 36) return;

  const direction = state.wheelDelta > 0 ? "next" : "prev";
  state.wheelDelta = 0;
  state.wheelTurnAt = now;
  turnPage(direction);
}

function handleReaderTouchStart(event) {
  state.touchStartY = event.changedTouches?.[0]?.clientY ?? null;
}

function handleReaderTouchEnd(event) {
  if (!currentScrollPager() || state.touchStartY == null) return;

  const endY = event.changedTouches?.[0]?.clientY;
  if (typeof endY !== "number") return;

  const delta = state.touchStartY - endY;
  state.touchStartY = null;
  if (Math.abs(delta) < 42) return;

  event.preventDefault();
  turnPage(delta > 0 ? "next" : "prev");
}

function adjustFontSize(delta) {
  const min = Number(els.fontSize.min) || 80;
  const max = Number(els.fontSize.max) || 170;
  const next = Math.max(min, Math.min(max, state.settings.fontSize + delta));
  state.settings.fontSize = next;
  els.fontSize.value = next;
  saveSettings();
  applyTheme();
}

async function turnPage(direction) {
  if (!state.rendition || state.turning) return;
  state.turning = true;
  try {
    const handled = await turnReaderPage(direction);
    if (!handled) {
      await state.rendition[direction]();
    }
    logPageMetrics(direction);
  } catch (error) {
    reportRendererError(error);
  } finally {
    state.turning = false;
  }
}

function requestOpenDialog() {
  window.ipc.postMessage(JSON.stringify({ command: "open-dialog" }));
}

function wirePresetResize() {
  if (!window.ResizeObserver || !els.readerShell) return;

  const observer = new ResizeObserver(() => {
    applyReaderPreset();
    if (!state.rendition) return;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => resizeRendition().catch(reportRendererError), 80);
  });
  observer.observe(els.readerShell);
}

function wireErrorReporting() {
  window.addEventListener("error", (event) => {
    reportRendererError(event.error || event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportRendererError(event.reason);
  });
}

function reportRendererError(error) {
  const message = error?.stack || error?.message || String(error || "Unknown renderer error");
  try {
    window.ipc.postMessage(JSON.stringify({ command: "renderer-log", level: "error", message }));
  } catch {
    // Native logging is best-effort; the in-app toast still handles user-visible errors.
  }
}

async function openPayload(payload, options = {}) {
  if (!payload?.url || state.opening) return;

  state.opening = true;
  document.body.classList.add("busy");
  els.reloadState.textContent = options.reason === "watch" ? "Reloading" : "Opening";

  const targetCfi = options.targetCfi || null;

  try {
    destroyBook();
    state.payload = payload;
    state.currentCfi = targetCfi || null;
    state.locationsReady = false;
    applyReaderPreset();

    const url = payload.url.endsWith("/book/")
      ? payload.url
      : `${payload.url}${payload.url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    state.book = ePub(url);
    state.rendition = state.book.renderTo(els.viewer, {
      width: state.viewport.width,
      height: state.viewport.height,
      manager: "default",
      flow: "scrolled-doc",
      resizeOnOrientationChange: true,
      allowScriptedContent: false
    });

    installRenditionHooks();
    wireRendition();
    applyTheme();
    updateFileFacts(payload);

    const displayTarget = targetCfi || await initialDisplayTarget().catch((error) => {
      reportRendererError(error);
      return null;
    });

    await state.rendition.display(displayTarget || undefined).catch(async () => {
      state.currentCfi = null;
      await state.rendition.display();
    });
    installPagedSurface();
    logPageMetrics("display");
    els.emptyState.classList.add("hidden");
    setReaderEnabled(true);
    els.reloadState.textContent = options.reason === "watch" ? "Updated" : "Watching";
    renderNavigation().catch(reportRendererError);
    queueLocationGeneration();
    showToast(options.reason === "watch" ? "Reloaded." : "EPUB loaded.");
  } catch (error) {
    console.error(error);
    reportRendererError(error);
    els.reloadState.textContent = "Error";
    showToast(error?.message || "Could not open EPUB.", "error");
  } finally {
    document.body.classList.remove("busy");
    state.opening = false;
  }
}

function destroyBook() {
  state.locationGenerationToken += 1;
  state.turning = false;
  state.wheelDelta = 0;
  state.wheelTurnAt = 0;
  state.touchStartY = null;
  state.rendition?.destroy?.();
  state.book?.destroy?.();
  els.viewer.replaceChildren();
  state.rendition = null;
  state.book = null;
  state.locationsReady = false;
}

function installRenditionHooks() {
  state.rendition.hooks.content.register((contents) => {
    contents.document.documentElement.style.scrollBehavior = "auto";
    contents.document.documentElement.style.overflowX = "hidden";
    contents.document.addEventListener("keydown", handleReaderKeydown);
    contents.document.addEventListener("wheel", handleReaderWheel, { passive: false });
    contents.document.addEventListener("touchstart", handleReaderTouchStart, { passive: true });
    contents.document.addEventListener("touchend", handleReaderTouchEnd, { passive: false });
    if (contents.document.body) {
      contents.document.body.style.textRendering = "optimizeLegibility";
    }
  });
}

function wireRendition() {
  state.rendition.on("relocated", (location) => {
    state.currentCfi = location?.start?.cfi || state.currentCfi;
    updateProgress(location);
  });

  state.rendition.on("rendered", applyTheme);
  state.rendition.on("rendered", installPagedSurface);
  state.rendition.on("resized", installPagedSurface);
  state.rendition.on("rendered", () => {
    clearTimeout(state.metricsTimer);
    state.metricsTimer = setTimeout(() => logPageMetrics("rendered"), 120);
  });
}

function installPagedSurface() {
  const manager = state.rendition?.manager;
  if (!manager?.container) return;

  applyPageMarginsToContents(manager);
  updatePageMaskForScroll(manager);
  manager.container.style.overflow = "hidden";
  manager.container.style.overflowX = "hidden";
  manager.container.style.overflowY = "hidden";
  manager.container.style.scrollBehavior = "auto";
  manager.container.style.overscrollBehavior = "none";
  manager.container.tabIndex = 0;

  if (manager._princeznoidPagedSurface) return;
  manager._princeznoidPagedSurface = true;
  manager.container.addEventListener("wheel", handleReaderWheel, { passive: false });
  manager.container.addEventListener("touchstart", handleReaderTouchStart, { passive: true });
  manager.container.addEventListener("touchend", handleReaderTouchEnd, { passive: false });
}

function applyPageMarginsToContents(manager) {
  const margins = getPageMargins(manager);

  els.viewer.style.setProperty("--page-margin-top", `${margins.top}px`);
  els.viewer.style.setProperty("--page-margin-bottom", `${margins.bottom}px`);

  manager?.views?.forEach?.((view) => {
    const body = view.contents?.document?.body;
    const guard = getGlyphGuard(view);
    const topValue = `${margins.top + guard}px`;
    const bottomValue = `${margins.bottom + guard}px`;
    const key = `${topValue}:${bottomValue}`;
    if (!body || body.dataset.princeznoidPageMargin === key) return;

    body.dataset.princeznoidPageMargin = key;
    body.style.paddingTop = topValue;
    body.style.paddingBottom = bottomValue;

    requestAnimationFrame(() => {
      delete view._princeznoidLineBoxes;
      delete view._princeznoidPageBreaks;
      if (view.displayed) view.expand?.();
    });
  });
}

function updatePageMaskForScroll(manager, view = manager?.views?.first?.()) {
  if (!manager?.container) return;

  const margins = getPageMargins(manager);
  const guard = getGlyphGuard(view);
  const height = Number(manager.container.clientHeight || state.viewport.height || 0);
  const currentTop = Number(manager.container.scrollTop) || 0;
  let bottom = margins.bottom;

  const lineBoxes = getReaderLineBoxes(view);
  if (lineBoxes.length) {
    const visibleTop = currentTop + margins.top + guard;
    const visibleBottom = currentTop + height - margins.bottom - guard;
    const clippedLine = lineBoxes.find((box) => (
      box.top > visibleTop + 0.5 &&
      box.top < visibleBottom - 0.5 &&
      box.bottom > visibleBottom + 0.5
    ));

    if (clippedLine) {
      bottom = Math.max(bottom, height - (clippedLine.top - currentTop) + guard);
    }
  }

  els.viewer.style.setProperty("--page-margin-top", `${margins.top}px`);
  els.viewer.style.setProperty("--page-margin-bottom", `${Math.max(1, Math.round(bottom))}px`);
}

async function turnReaderPage(direction) {
  const pager = currentScrollPager();
  if (!pager) return false;

  const { manager, view, container } = pager;
  const currentTop = Math.max(0, Number(container.scrollTop) || 0);
  const pageBreaks = getPageBreaks(manager, view);

  if (direction === "next") {
    const nextTop = pageBreaks.find((top) => top > currentTop + 0.5);
    if (typeof nextTop === "number") {
      scrollToReaderPage(manager, nextTop);
      await reportReaderLocation();
      return true;
    }

    const nextSection = view.section?.next?.();
    if (!nextSection) return false;

    await state.rendition.display(nextSection.href || nextSection);
    scrollToReaderPage(state.rendition.manager, 0);
    await reportReaderLocation();
    return true;
  }

  const previousTop = [...pageBreaks].reverse().find((top) => top < currentTop - 0.5);
  if (typeof previousTop === "number") {
    scrollToReaderPage(manager, previousTop);
    await reportReaderLocation();
    return true;
  }

  const previousSection = view.section?.prev?.();
  if (!previousSection) return false;

  await state.rendition.display(previousSection.href || previousSection);
  await waitForAnimationFrames(2);

  const previousPager = currentScrollPager();
  if (previousPager) {
    scrollToReaderPage(previousPager.manager, getLastPageTop(previousPager.manager, previousPager.view));
  }
  await reportReaderLocation();
  return true;
}

function currentScrollPager() {
  const manager = state.rendition?.manager;
  const view = manager?.views?.first?.();
  if (
    !manager?.container ||
    manager.isPaginated ||
    manager.settings?.axis !== "vertical" ||
    manager.settings?.fullsize ||
    !view?.contents
  ) {
    return null;
  }
  return { manager, view, container: manager.container };
}

function getScrollPageStep(manager) {
  const view = manager?.views?.first?.();
  const metrics = getLinePageMetrics(manager, view);
  if (metrics.pageStep) return metrics.pageStep;

  const margins = getPageMargins(manager);
  const height = Math.round(
    manager?.container?.clientHeight ||
    manager?.layout?.height ||
    state.viewport.height ||
    1
  );

  return Math.max(1, height - margins.top - margins.bottom);
}

function getLinePageMetrics(manager, view) {
  const height = Number(manager?.container?.clientHeight || manager?.layout?.height || state.viewport.height || 0);
  const baseMargin = getBasePageMargin(manager);
  const lineHeight = getReaderLineHeight(view);
  const guard = getGlyphGuardFromLineHeight(lineHeight);
  const rawTextHeight = Math.max(1, height - (baseMargin * 2) - (guard * 2));
  const linesPerPage = lineHeight ? Math.max(1, Math.floor(rawTextHeight / lineHeight)) : 0;
  const pageStep = lineHeight && linesPerPage ? linesPerPage * lineHeight : 0;
  const textHeight = pageStep || rawTextHeight;
  const bottomMargin = Math.max(baseMargin, height - baseMargin - textHeight - (guard * 2));

  return {
    glyphGuard: guard,
    lineHeight,
    linesPerPage,
    pageStep,
    textHeight,
    margins: {
      top: baseMargin,
      bottom: bottomMargin,
      total: baseMargin + bottomMargin
    }
  };
}

function getReaderLineHeight(view) {
  const body = view?.contents?.document?.body;
  const win = view?.contents?.document?.defaultView;
  if (!body || !win) return 0;

  const styles = win.getComputedStyle(body);
  const lineHeight = Number.parseFloat(styles.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;

  const fontSize = Number.parseFloat(styles.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.54 : 0;
}

function getGlyphGuard(view) {
  return getGlyphGuardFromLineHeight(getReaderLineHeight(view));
}

function getGlyphGuardFromLineHeight(lineHeight) {
  const normalized = Number(lineHeight) || 0;
  return Math.round(Math.max(
    GLYPH_GUARD.min,
    Math.min(GLYPH_GUARD.max, normalized * GLYPH_GUARD.ratio)
  ));
}

function getPageMargins(manager) {
  const metrics = getLinePageMetrics(manager, manager?.views?.first?.());
  if (metrics.margins) return metrics.margins;

  const block = getBasePageMargin(manager);
  return { top: block, bottom: block, total: block * 2 };
}

function getBasePageMargin(manager) {
  const height = Number(manager?.container?.clientHeight || state.viewport.height || 0);
  const fallback = pageMarginForHeight(height);
  const raw = els.viewer.style.getPropertyValue("--page-margin-block");
  const margin = Number.parseFloat(raw);
  return Math.max(0, Math.round(
    Number.isFinite(margin) ? margin : fallback
  ));
}

function pageMarginForHeight(height) {
  return normalizePageMargin(state.settings.pageMargin);
}

function normalizePageMargin(value) {
  const number = Number(value);
  const fallback = PAGE_MARGIN_RANGE.default;
  return Math.round(Math.max(
    PAGE_MARGIN_RANGE.min,
    Math.min(PAGE_MARGIN_RANGE.max, Number.isFinite(number) ? number : fallback)
  ));
}

function getMaxScrollTop(manager, view) {
  const breaks = getPageBreaks(manager, view);
  if (breaks.length) return breaks[breaks.length - 1];

  return getRawMaxScrollTop(manager, view);
}

function getRawMaxScrollTop(manager, view) {
  const container = manager?.container;
  if (!container) return 0;
  return Math.max(
    0,
    Math.ceil(Number(container.scrollHeight) - Number(container.clientHeight)),
    Math.ceil((Number(view?.height?.()) || 0) - Number(container.clientHeight))
  );
}

function getLastPageTop(manager, view) {
  const breaks = getPageBreaks(manager, view);
  return breaks.length ? breaks[breaks.length - 1] : getRawMaxScrollTop(manager, view);
}

function getPageBreaks(manager, view) {
  const container = manager?.container;
  const body = view?.contents?.document?.body;
  if (!container || !view || !body) return [0];

  const margins = getPageMargins(manager);
  const guard = getGlyphGuard(view);
  const height = Number(container.clientHeight || state.viewport.height || 0);
  const textHeight = Math.max(1, height - margins.total - (guard * 2));
  const rawMaxTop = getRawMaxScrollTop(manager, view);
  const lineBoxes = getReaderLineBoxes(view);
  const cacheKey = [
    Math.round(height),
    Math.round(Number(container.clientWidth) || 0),
    Math.round(Number(view.height?.()) || 0),
    Math.round(rawMaxTop),
    margins.top,
    margins.bottom,
    state.settings.pageMargin,
    state.settings.fontSize,
    lineBoxes.length,
    Math.round(lineBoxes[0]?.top || 0),
    Math.round(lineBoxes[lineBoxes.length - 1]?.bottom || 0)
  ].join(":");

  if (view._princeznoidPageBreaks?.key === cacheKey) {
    return view._princeznoidPageBreaks.breaks;
  }

  if (!lineBoxes.length || textHeight <= 1) {
    const fallbackStep = Math.max(1, textHeight);
    const fallbackBreaks = [];
    for (let top = 0; top < rawMaxTop - 0.5; top += fallbackStep) {
      fallbackBreaks.push(Math.min(top, rawMaxTop));
    }
    fallbackBreaks.push(rawMaxTop);
    view._princeznoidPageBreaks = { key: cacheKey, breaks: uniquePageBreaks(fallbackBreaks) };
    return view._princeznoidPageBreaks.breaks;
  }

  const breaks = [0];
  let visibleTop = margins.top + guard;
  let lastScrollTop = 0;

  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const visibleBottom = visibleTop + textHeight;
    const nextLine = lineBoxes.find((box) => (
      box.top > visibleTop + 0.5 &&
      box.bottom > visibleBottom + 0.5
    ));

    if (!nextLine) break;

    const nextScrollTop = Math.max(0, Math.min(rawMaxTop, nextLine.top - margins.top - guard));
    if (nextScrollTop <= lastScrollTop + 0.5) break;

    breaks.push(nextScrollTop);
    lastScrollTop = nextScrollTop;
    visibleTop = nextScrollTop + margins.top + guard;

    if (nextScrollTop >= rawMaxTop - 0.5) break;
  }

  view._princeznoidPageBreaks = { key: cacheKey, breaks: uniquePageBreaks(breaks) };
  return view._princeznoidPageBreaks.breaks;
}

function getReaderLineBoxes(view) {
  const doc = view?.contents?.document;
  const body = doc?.body;
  if (!doc || !body) return [];

  const lineHeight = getReaderLineHeight(view) || 18;
  const cacheKey = [
    state.settings.fontSize,
    body.dataset.princeznoidPageMargin || "",
    Math.round(Number(view.height?.()) || 0),
    Math.round(Number(body.scrollHeight) || 0),
    Math.round(lineHeight * 100)
  ].join(":");

  if (view._princeznoidLineBoxes?.key === cacheKey) {
    return view._princeznoidLineBoxes.boxes;
  }

  const boxes = [];
  const nodeFilter = doc.defaultView?.NodeFilter || window.NodeFilter;
  const walker = doc.createTreeWalker(body, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.nodeValue && node.nodeValue.trim()
        ? nodeFilter.FILTER_ACCEPT
        : nodeFilter.FILTER_REJECT;
    }
  });
  const range = doc.createRange();

  while (walker.nextNode()) {
    range.selectNodeContents(walker.currentNode);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1 || rect.height < 1) continue;
      boxes.push({ top: rect.top, bottom: rect.bottom });
    }
  }
  range.detach?.();

  const merged = mergeLineBoxes(boxes, lineHeight);
  view._princeznoidLineBoxes = { key: cacheKey, boxes: merged };
  return merged;
}

function mergeLineBoxes(boxes, lineHeight) {
  const tolerance = Math.max(2, lineHeight * 0.35);
  const merged = [];

  boxes
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom)
    .forEach((box) => {
      const center = (box.top + box.bottom) / 2;
      const last = merged[merged.length - 1];
      if (last && Math.abs(center - last.center) <= tolerance) {
        last.top = Math.min(last.top, box.top);
        last.bottom = Math.max(last.bottom, box.bottom);
        last.center = (last.top + last.bottom) / 2;
      } else {
        merged.push({ ...box, center });
      }
    });

  return merged.map(({ top, bottom }) => ({ top, bottom }));
}

function uniquePageBreaks(breaks) {
  const unique = [];
  for (const top of breaks) {
    const normalized = Math.max(0, Number(top) || 0);
    const previous = unique[unique.length - 1];
    if (typeof previous !== "number" || Math.abs(normalized - previous) > 0.5) {
      unique.push(normalized);
    }
  }
  return unique.length ? unique : [0];
}

function scrollToReaderPage(manager, top) {
  if (!manager?.container) return;
  const clampedTop = Math.max(0, Math.min(getMaxScrollTop(manager, manager.views?.first?.()), Number(top) || 0));
  manager.container.scrollLeft = 0;
  manager.container.scrollTop = clampedTop;
  manager.scrollLeft = 0;
  manager.scrollTop = clampedTop;
  manager.scrolled = true;
  updatePageMaskForScroll(manager, manager.views?.first?.());
}

async function reportReaderLocation() {
  await waitForAnimationFrames(1);
  await state.rendition?.reportLocation?.();
}

function waitForAnimationFrames(count) {
  return new Promise((resolve) => {
    const tick = () => {
      count -= 1;
      if (count <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

async function initialDisplayTarget() {
  const navigation = await state.book.loaded.navigation;
  const toc = Array.isArray(navigation?.toc) ? navigation.toc : [];
  const tocTarget = flattenToc(toc)
    .map((item) => item.href)
    .find(isReadableHref);

  if (tocTarget) return tocTarget;

  await state.book.opened;
  return firstReadableSpineHref();
}

function firstReadableSpineHref() {
  const spineItems = state.book?.spine?.spineItems || [];
  const item = spineItems.find((section) => section.linear && isReadableHref(section.href))
    || spineItems.find((section) => section.linear)
    || spineItems[0];
  return item?.href || null;
}

function isReadableHref(href) {
  if (!href) return false;
  const fileName = href.split("#")[0].split("/").pop().toLowerCase();
  return !/^(cover|nav|toc|contents?|title[-_]?page|titlepage)\.(xhtml|html|htm)$/i.test(fileName);
}

function logPageMetrics(reason) {
  const manager = state.rendition?.manager;
  const view = manager?.views?.first?.();
  if (!manager || !view) return;
  const lineMetrics = getLinePageMetrics(manager, view);
  const pageBreaks = getPageBreaks(manager, view);

  const metrics = {
    reason,
    preset: state.settings.preset,
    viewport: state.viewport,
    layout: manager.layout && {
      width: manager.layout.width,
      height: manager.layout.height,
      pageWidth: manager.layout.pageWidth,
      delta: manager.layout.delta,
      columnWidth: manager.layout.columnWidth,
      gap: manager.layout.gap,
      divisor: manager.layout.divisor
    },
    container: manager.container && {
      offsetWidth: manager.container.offsetWidth,
      clientWidth: manager.container.clientWidth,
      offsetHeight: manager.container.offsetHeight,
      clientHeight: manager.container.clientHeight,
      scrollWidth: manager.container.scrollWidth,
      scrollHeight: manager.container.scrollHeight,
      scrollLeft: manager.container.scrollLeft,
      scrollTop: manager.container.scrollTop
    },
    scroller: {
      pageStep: lineMetrics.pageStep || getScrollPageStep(manager),
      maxScrollTop: getMaxScrollTop(manager, view),
      pageMargin: getPageMargins(manager),
      lineHeight: lineMetrics.lineHeight,
      linesPerPage: lineMetrics.linesPerPage,
      pageCount: pageBreaks.length,
      maskTop: els.viewer.style.getPropertyValue("--page-margin-top"),
      maskBottom: els.viewer.style.getPropertyValue("--page-margin-bottom")
    },
    view: {
      index: view.index,
      width: view.width?.(),
      height: view.height?.(),
      elementWidth: view.element?.offsetWidth,
      iframeWidth: view.iframe?.offsetWidth
    },
    location: state.rendition.location?.start?.displayed
  };

  try {
    window.ipc.postMessage(JSON.stringify({
      command: "renderer-log",
      level: "debug",
      message: `page metrics ${JSON.stringify(metrics)}`
    }));
  } catch {
    // Debug telemetry is best-effort.
  }
}

function applyReaderPreset() {
  const preset = READER_PRESETS[state.settings.preset] || READER_PRESETS.fluid;
  const bounds = els.readerShell.getBoundingClientRect();
  const availableWidth = Math.max(280, Math.floor(bounds.width - 36));
  const availableHeight = Math.max(360, Math.floor(bounds.height - 36));

  if (!preset.width || !preset.height) {
    els.viewer.style.width = `${availableWidth}px`;
    els.viewer.style.height = `${availableHeight}px`;
    els.viewer.style.removeProperty("aspect-ratio");
    state.viewport = { width: availableWidth, height: availableHeight };
    applyViewerPageMargin();
    return;
  }

  const scale = Math.min(availableWidth / preset.width, availableHeight / preset.height, 1);
  const width = Math.max(260, Math.floor(preset.width * scale));
  const height = Math.max(320, Math.floor(preset.height * scale));

  els.viewer.style.width = `${width}px`;
  els.viewer.style.height = `${height}px`;
  els.viewer.style.aspectRatio = `${preset.width} / ${preset.height}`;
  state.viewport = { width, height };
  applyViewerPageMargin();
}

function applyViewerPageMargin() {
  const margin = `${pageMarginForHeight()}px`;
  els.viewer.style.setProperty("--page-margin-block", margin);
  els.viewer.style.setProperty("--page-margin-top", margin);
  els.viewer.style.setProperty("--page-margin-bottom", margin);
}

async function resizeRendition() {
  if (!state.rendition) return;
  applyReaderPreset();
  state.rendition.resize(state.viewport.width, state.viewport.height, state.currentCfi || undefined);
  await state.rendition.display(state.currentCfi || undefined);
}

async function renderNavigation() {
  const navigation = await state.book.loaded.navigation;
  const toc = Array.isArray(navigation?.toc) ? navigation.toc : [];
  els.tocList.replaceChildren();

  if (!toc.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No contents.";
    els.tocList.append(empty);
    return;
  }

  for (const item of flattenToc(toc)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toc-item";
    button.style.setProperty("--depth", item.depth);
    button.textContent = item.label || item.href;
    button.title = item.label || item.href;
    button.addEventListener("click", () => state.rendition?.display(item.href));
    els.tocList.append(button);
  }
}

function flattenToc(items, depth = 0) {
  return items.flatMap((item) => [
    { ...item, depth },
    ...flattenToc(item.subitems || [], depth + 1)
  ]);
}

function queueLocationGeneration() {
  const token = ++state.locationGenerationToken;
  const run = () => generateLocations(token).catch(reportRendererError);

  if (window.requestIdleCallback) {
    window.requestIdleCallback(run, { timeout: 1600 });
  } else {
    setTimeout(run, 250);
  }
}

async function generateLocations(token) {
  await state.book.ready;
  if (token !== state.locationGenerationToken) return;
  els.reloadState.textContent = "Indexing";
  await state.book.locations.generate(1200);
  if (token !== state.locationGenerationToken) return;
  state.locationsReady = true;
  els.reloadState.textContent = "Watching";
  updateProgress();
}

function updateProgress(location) {
  let percent = 0;
  if (state.locationsReady && state.currentCfi && state.book?.locations) {
    percent = Math.round(state.book.locations.percentageFromCfi(state.currentCfi) * 100);
  } else if (location?.start?.percentage) {
    percent = Math.round(location.start.percentage * 100);
  }
  percent = Math.max(0, Math.min(100, percent || 0));
  els.progressText.textContent = `${percent}%`;
  els.progressBar.style.width = `${percent}%`;
}

function applyTheme() {
  applyChromeTheme();
  if (!state.rendition) return;

  state.rendition.themes.register("princeznoid", themeRules(state.settings.theme));
  state.rendition.themes.select("princeznoid");
  state.rendition.themes.fontSize(`${state.settings.fontSize}%`);
}

function themeRules(theme) {
  const normalizedTheme = normalizeTheme(theme);
  const common = {
    img: { "max-width": "100% !important", "height": "auto !important" },
    "::selection": {
      color: `${normalizedTheme === "dark" ? "#000000" : "#ffffff"} !important`,
      background: `${normalizedTheme === "dark" ? "#fe5d40" : "#ff83af"} !important`
    }
  };
  const themes = {
    light: {
      body: {
        color: "#000000 !important",
        background: "#ffffff !important",
        "font-family": "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif !important",
        "line-height": "1.54 !important"
      },
      a: { color: "#cc4f7b !important" },
      ...common
    },
    dark: {
      body: {
        color: "#ffffff !important",
        background: "#000000 !important",
        "font-family": "Georgia, 'Iowan Old Style', 'Palatino Linotype', serif !important",
        "line-height": "1.56 !important"
      },
      a: { color: "#fe5d40 !important" },
      ...common
    }
  };
  return themes[normalizedTheme] || themes.light;
}

function applyChromeTheme() {
  document.body.dataset.theme = normalizeTheme(state.settings.theme);
}

function normalizeTheme(theme) {
  const normalized = THEME_ALIASES[theme] || theme;
  return THEMES.has(normalized) ? normalized : "light";
}

function updateFileFacts(payload) {
  els.fileLabel.textContent = payload.title || payload.name;
  els.fileName.textContent = payload.name;
  els.fileName.title = payload.path;
  els.fileSize.textContent = formatBytes(payload.size);
}

function setReaderEnabled(enabled) {
  els.prevButton.disabled = !enabled;
  els.nextButton.disabled = !enabled;
  els.reloadButton.disabled = !enabled;
}

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.className = `visible ${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.className = "";
  }, 2200);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem("princeznoid-settings") || "{}");
    const settings = { ...DEFAULT_SETTINGS, ...raw };

    settings.theme = normalizeTheme(settings.theme);
    settings.preset = READER_PRESETS[settings.preset] ? settings.preset : DEFAULT_SETTINGS.preset;
    settings.fontSize = Number(settings.fontSize) || DEFAULT_SETTINGS.fontSize;
    settings.pageMargin = normalizePageMargin(settings.pageMargin);
    settings.cfiByPath = settings.cfiByPath && typeof settings.cfiByPath === "object" ? settings.cfiByPath : {};

    if (!SPREAD_MODES.has(settings.spread)) settings.spread = DEFAULT_SETTINGS.spread;
    if (raw.version !== SETTINGS_VERSION && raw.spread === "auto") settings.spread = "none";
    settings.version = SETTINGS_VERSION;

    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function syncSettings() {
  els.fontSize.value = state.settings.fontSize;
  syncPageMarginControl();
  els.readerPreset.value = state.settings.preset;
  els.spreadMode.value = state.settings.spread;
  els.themeMode.value = state.settings.theme;
}

function syncPageMarginControl() {
  const margin = normalizePageMargin(state.settings.pageMargin);
  state.settings.pageMargin = margin;
  els.pageMargin.value = margin;
  els.pageMarginValue.textContent = `${margin}px`;
}

function saveSettings() {
  localStorage.setItem("princeznoid-settings", JSON.stringify(state.settings));
}
