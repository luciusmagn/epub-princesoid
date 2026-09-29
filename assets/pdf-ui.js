const pdfEls = {
  controls: document.querySelector("#pdf-controls"),
  pageInput: document.querySelector("#pdf-page-input"),
  pageTotal: document.querySelector("#pdf-page-total"),
  language: document.querySelector("#pdf-language"),
  runChecks: document.querySelector("#pdf-run-checks"),
  status: document.querySelector("#pdf-scan-status"),
  count: document.querySelector("#pdf-count"),
  prevIssue: document.querySelector("#pdf-prev-issue"),
  nextIssue: document.querySelector("#pdf-next-issue"),
  filter: document.querySelector("#pdf-filter"),
  wordOpen: document.querySelector("#pdf-words-open"),
  wordDialog: document.querySelector("#pdf-words-dialog"),
  wordClose: document.querySelector("#pdf-words-close"),
  wordCount: document.querySelector("#pdf-word-count"),
  wordForm: document.querySelector("#pdf-word-form"),
  wordInput: document.querySelector("#pdf-word-input"),
  wordSearch: document.querySelector("#pdf-word-search"),
  wordList: document.querySelector("#pdf-word-list"),
  issues: document.querySelector("#pdf-issue-list"),
  shell: document.querySelector("#pdf-page-shell"),
  stage: document.querySelector("#pdf-stage"),
  image: document.querySelector("#pdf-page-image"),
  overlays: document.querySelector("#pdf-overlays"),
  caption: document.querySelector("#pdf-page-caption")
};

const pdfState = {
  payload: null,
  page: 1,
  zoom: 1,
  report: null,
  activeFinding: null,
  visibleFindings: [],
  ignored: new Set(),
  allowedWords: readAllowedWords(),
  characterPages: new Map(),
  focusRect: null,
  focusZoomRestore: null,
  focusRequest: 0,
  wheelAt: 0
};

const PDF_LANGUAGES = { en: "English", cs: "Czech", es: "Spanish", de: "German" };
const PDF_CATEGORIES = {
  coverage: "Text coverage", image: "Image", toc: "Contents", hyphenation: "Word break", dash: "Dash",
  quote: "Quotes", spacing: "Spacing", spelling: "Spelling", language: "Language", widow: "Page break"
};

try {
  const saved = localStorage.getItem("princeznoid-pdf-language");
  if (["auto", "en", "cs", "es", "de"].includes(saved)) pdfEls.language.value = saved;
} catch { /* The picker still works when storage is unavailable. */ }

pdfEls.pageInput.addEventListener("change", () => navigatePdfPage(Number(pdfEls.pageInput.value)));
pdfEls.pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    navigatePdfPage(Number(pdfEls.pageInput.value));
    pdfEls.pageInput.blur();
  }
});
pdfEls.language.addEventListener("change", () => {
  try { localStorage.setItem("princeznoid-pdf-language", pdfEls.language.value); } catch { /* no persistence */ }
  requestPdfScan();
});
pdfEls.runChecks.addEventListener("click", requestPdfScan);
pdfEls.filter.addEventListener("change", () => { clearFindingFocus(); renderFindings(); });
pdfEls.prevIssue.addEventListener("click", () => navigateFinding(-1));
pdfEls.nextIssue.addEventListener("click", () => navigateFinding(1));
pdfEls.wordOpen.addEventListener("click", () => {
  pdfEls.wordSearch.value = "";
  renderAllowedWords();
  pdfEls.wordDialog.showModal();
  pdfEls.wordSearch.focus();
});
pdfEls.wordClose.addEventListener("click", () => pdfEls.wordDialog.close());
pdfEls.wordSearch.addEventListener("input", renderAllowedWords);
pdfEls.wordForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addAllowedWord(pdfEls.wordInput.value);
});
pdfEls.wordInput.addEventListener("input", () => pdfEls.wordInput.setCustomValidity(""));
pdfEls.image.addEventListener("load", () => {
  renderMarkers();
  if (pdfState.activeFinding?.rect) centerOnRect(pdfState.focusRect || pdfState.activeFinding.rect);
});
pdfEls.image.addEventListener("error", () => {
  pdfEls.caption.textContent = `Could not render PDF page ${pdfState.page}.`;
});
pdfEls.shell.addEventListener("wheel", (event) => {
  if (pdfState.zoom > 1 || event.ctrlKey || Math.abs(event.deltaY) < 15) return;
  event.preventDefault();
  if (Date.now() - pdfState.wheelAt < 250) return;
  pdfState.wheelAt = Date.now();
  turnPdfPage(event.deltaY > 0 ? "next" : "prev");
}, { passive: false });

if (window.ResizeObserver) new ResizeObserver(fitPdfPage).observe(pdfEls.shell);

function openPdf(payload, options = {}) {
  const sameFile = pdfState.payload?.path === payload.path;
  const previousPage = sameFile && options.reason === "watch" ? pdfState.page : 1;
  destroyBook();
  state.payload = payload;
  pdfState.payload = payload;
  pdfState.report = null;
  pdfState.activeFinding = null;
  pdfState.focusRect = null;
  pdfState.focusZoomRestore = null;
  pdfState.focusRequest++;
  pdfState.characterPages.clear();
  pdfState.zoom = 1;
  pdfState.page = Math.min(previousPage, payload.pdf.page_count);
  pdfState.ignored = readIgnored(payload.path);
  document.body.dataset.document = "pdf";
  els.emptyState.classList.add("hidden");
  updateFileFacts(payload);
  setReaderEnabled(true);
  pdfEls.pageInput.max = payload.pdf.page_count;
  pdfEls.pageTotal.textContent = `/ ${payload.pdf.page_count}`;
  pdfEls.filter.value = "all";
  pdfEls.count.textContent = "0";
  pdfEls.prevIssue.disabled = true;
  pdfEls.nextIssue.disabled = true;
  pdfState.visibleFindings = [];
  pdfEls.issues.replaceChildren();
  renderAllowedWords();
  goToPage(pdfState.page, true);
  requestPdfScan();
  els.reloadState.textContent = options.reason === "watch" ? "Updated" : "Watching";
}

function closePdf() {
  if (pdfEls.wordDialog.open) pdfEls.wordDialog.close();
  pdfState.payload = null;
  pdfState.report = null;
  pdfState.activeFinding = null;
  pdfState.focusRect = null;
  pdfState.focusZoomRestore = null;
  pdfState.focusRequest++;
  pdfState.characterPages.clear();
  pdfState.visibleFindings = [];
  pdfEls.image.removeAttribute("src");
  pdfEls.overlays.replaceChildren();
}

function requestPdfScan() {
  if (!pdfState.payload) return;
  pdfEls.status.textContent = "Checking pages…";
  pdfEls.runChecks.disabled = true;
  window.ipc.postMessage(JSON.stringify({ command: "scan-pdf", language: pdfEls.language.value, accepted_words: [...pdfState.allowedWords] }));
}

function showPdfReport(report) {
  if (!pdfState.payload) return;
  pdfState.report = report;
  clearFindingFocus();
  pdfEls.runChecks.disabled = false;
  pdfEls.status.textContent = `${PDF_LANGUAGES[report.language] || report.language} · ${pdfState.payload.pdf.page_count} pages checked`;
  renderFindings();
  renderMarkers();
}

function showPdfScanError(message) {
  pdfEls.runChecks.disabled = false;
  pdfEls.status.textContent = `Check failed: ${message}`;
  reportRendererError(message);
}

function goToPage(page, force = false) {
  if (!pdfState.payload) return;
  const next = Math.max(1, Math.min(pdfState.payload.pdf.page_count, Math.floor(page) || 1));
  if (next === pdfState.page && !force) {
    pdfEls.pageInput.value = next;
    return;
  }
  pdfState.page = next;
  pdfEls.pageInput.value = next;
  pdfEls.overlays.replaceChildren();
  fitPdfPage();
  pdfEls.image.src = `princeznoid://app/pdf-page/${next}.png?revision=${pdfState.payload.revision}`;
  const label = pdfState.payload.pdf.labels[next - 1] || String(next);
  pdfEls.caption.textContent = label === String(next) ? `Page ${next}` : `Page ${label} · PDF ${next}`;
  pdfEls.shell.scrollTo({ top: 0, left: 0, behavior: "instant" });
  renderMarkers();
}

function fitPdfPage() {
  if (!pdfState.payload) return;
  const size = pdfState.payload.pdf.sizes[pdfState.page - 1];
  if (!size) return;
  const availableWidth = Math.max(100, pdfEls.shell.clientWidth - 24);
  const availableHeight = Math.max(100, pdfEls.shell.clientHeight - 42);
  const baseScale = Math.min(availableWidth / size.width, availableHeight / size.height);
  const scale = baseScale * pdfState.zoom;
  pdfEls.stage.style.width = `${Math.round(size.width * scale)}px`;
  pdfEls.stage.style.height = `${Math.round(size.height * scale)}px`;
}

function turnPdfPage(direction) {
  clearFindingFocus();
  goToPage(pdfState.page + (direction === "next" ? 1 : -1));
}

function navigatePdfPage(page) {
  clearFindingFocus();
  goToPage(page);
}

function adjustPdfZoom(delta) {
  pdfState.focusZoomRestore = null;
  pdfState.zoom = Math.min(2.5, Math.max(0.5, Math.round((pdfState.zoom + delta) * 10) / 10));
  fitPdfPage();
  if (pdfState.activeFinding?.rect) centerOnRect(pdfState.focusRect || pdfState.activeFinding.rect);
}

function findingKey(finding) {
  return `${finding.category}\u001f${finding.title}\u001f${finding.excerpt}`;
}

function normalizeAllowedWord(value) {
  const word = value.normalize("NFC").trim().toLowerCase();
  return /^\p{L}{2,64}$/u.test(word) ? word : null;
}

function readAllowedWords() {
  try {
    const saved = JSON.parse(localStorage.getItem("princeznoid-allowed-words") || "[]");
    return new Set(Array.isArray(saved) ? saved.map(normalizeAllowedWord).filter(Boolean) : []);
  } catch { return new Set(); }
}

function saveAllowedWords() {
  try { localStorage.setItem("princeznoid-allowed-words", JSON.stringify([...pdfState.allowedWords].sort())); }
  catch { /* no persistence */ }
}

function renderAllowedWords() {
  const defaults = new Set(pdfState.payload?.accepted_defaults || []);
  const words = [...new Set([...defaults, ...pdfState.allowedWords])].sort((a, b) => a.localeCompare(b));
  const search = (pdfEls.wordSearch.value || "").trim().toLowerCase();
  const visible = words.filter((word) => word.includes(search));
  pdfEls.wordCount.textContent = search ? `${visible.length} / ${words.length}` : words.length;
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "pdf-word-empty";
    empty.textContent = "No matching words.";
    fragment.append(empty);
  }
  for (const word of visible) {
    const row = document.createElement("div");
    row.className = "pdf-word";
    const label = document.createElement("span");
    label.textContent = word;
    row.append(label);
    if (defaults.has(word)) {
      const status = document.createElement("span");
      status.className = "pdf-word-default";
      status.textContent = "Default";
      row.append(status);
    } else {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.title = `Remove ${word}`;
      remove.setAttribute("aria-label", `Remove ${word}`);
      remove.addEventListener("click", () => {
        pdfState.allowedWords.delete(word);
        saveAllowedWords();
        renderAllowedWords();
        requestPdfScan();
      });
      row.append(remove);
    }
    fragment.append(row);
  }
  pdfEls.wordList.replaceChildren(fragment);
}

function addAllowedWord(value) {
  const word = normalizeAllowedWord(value);
  if (!word) {
    pdfEls.wordInput.setCustomValidity("Enter one word of 2–64 letters.");
    pdfEls.wordInput.reportValidity();
    return;
  }
  pdfEls.wordInput.value = "";
  if (pdfState.payload?.accepted_defaults?.includes(word) || pdfState.allowedWords.has(word)) return;
  pdfState.allowedWords.add(word);
  pdfEls.wordSearch.value = "";
  saveAllowedWords();
  renderAllowedWords();
  if (pdfState.activeFinding?.category === "spelling" && pdfState.activeFinding.locator === word) clearFindingFocus();
  renderFindings();
  renderMarkers();
  if (!pdfEls.wordDialog.open) showToast(`${word} allowed.`);
}

function findingIsHidden(finding) {
  return pdfState.ignored.has(findingKey(finding)) ||
    (finding.category === "spelling" && pdfState.allowedWords.has(finding.locator));
}

function readIgnored(path) {
  try { return new Set(JSON.parse(localStorage.getItem(`princeznoid-ignored:${path}`) || "[]")); }
  catch { return new Set(); }
}

function ignoreFinding(finding) {
  pdfState.ignored.add(findingKey(finding));
  try { localStorage.setItem(`princeznoid-ignored:${pdfState.payload.path}`, JSON.stringify([...pdfState.ignored])); }
  catch { /* no persistence */ }
  if (pdfState.activeFinding?.id === finding.id) clearFindingFocus();
  renderFindings();
  renderMarkers();
}

function renderFindings() {
  if (!pdfState.report) return;
  const category = pdfEls.filter.value;
  const all = pdfState.report.findings.filter((finding) => !findingIsHidden(finding));
  const visible = all.filter((finding) => category === "all" || finding.category === category);
  pdfState.visibleFindings = visible;
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "muted pdf-empty-list";
    empty.textContent = "No findings in this view.";
    fragment.append(empty);
  }
  for (const finding of visible) {
    const row = document.createElement("div");
    row.className = `pdf-issue${pdfState.activeFinding?.id === finding.id ? " active" : ""}${finding.category === "spelling" && finding.locator ? " has-allow" : ""}`;
    row.dataset.findingId = String(finding.id);
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const header = document.createElement("span");
    header.className = "pdf-issue-header";
    const categoryText = document.createElement("span");
    categoryText.textContent = PDF_CATEGORIES[finding.category] || finding.category;
    const pageText = document.createElement("span");
    pageText.className = "pdf-issue-page";
    pageText.textContent = `p. ${pdfState.payload.pdf.labels[finding.page - 1] || finding.page}`;
    header.append(categoryText, pageText);
    const title = document.createElement("span");
    title.className = "pdf-issue-title";
    title.textContent = finding.title;
    const excerpt = document.createElement("span");
    excerpt.className = "pdf-issue-excerpt";
    appendFindingExcerpt(excerpt, finding);
    if (finding.category === "spelling" && finding.locator) {
      const allow = document.createElement("button");
      allow.className = "pdf-allow";
      allow.type = "button";
      allow.title = `Always allow ${finding.locator}`;
      allow.setAttribute("aria-label", `Always allow ${finding.locator}`);
      allow.textContent = "+";
      allow.addEventListener("click", (event) => { event.stopPropagation(); addAllowedWord(finding.locator); });
      row.append(allow);
    }
    const ignore = document.createElement("button");
    ignore.className = "pdf-ignore";
    ignore.type = "button";
    ignore.title = "Ignore this finding";
    ignore.setAttribute("aria-label", "Ignore this finding");
    ignore.textContent = "×";
    ignore.addEventListener("click", (event) => { event.stopPropagation(); ignoreFinding(finding); });
    row.addEventListener("click", () => selectFinding(finding, row));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectFinding(finding, row); }
    });
    row.append(header, title, excerpt, ignore);
    fragment.append(row);
  }
  pdfEls.issues.replaceChildren(fragment);
  updateFindingNavigation();
}

function updateFindingNavigation() {
  const index = pdfState.visibleFindings.findIndex((finding) => finding.id === pdfState.activeFinding?.id);
  const count = pdfState.visibleFindings.length;
  pdfEls.count.textContent = index >= 0 ? `${index + 1} / ${count}` : String(count);
  pdfEls.prevIssue.disabled = count === 0 || index === 0;
  pdfEls.nextIssue.disabled = count === 0 || index === count - 1;
}

function navigateFinding(direction) {
  const visible = pdfState.visibleFindings;
  if (!visible.length) return;
  const current = visible.findIndex((finding) => finding.id === pdfState.activeFinding?.id);
  let index;
  if (current >= 0) {
    index = Math.max(0, Math.min(visible.length - 1, current + direction));
  } else if (direction > 0) {
    index = visible.findIndex((finding) => finding.page >= pdfState.page);
    if (index < 0) index = visible.length - 1;
  } else {
    index = visible.length - 1;
    while (index > 0 && visible[index].page > pdfState.page) index--;
  }
  const finding = visible[index];
  const row = pdfEls.issues.querySelector(`[data-finding-id="${finding.id}"]`);
  if (row) selectFinding(finding, row);
}

function appendFindingExcerpt(element, finding) {
  const target = finding.locator;
  const index = target ? finding.excerpt.toLowerCase().indexOf(target.toLowerCase()) : -1;
  if (index < 0) { element.textContent = finding.excerpt; return; }
  const marker = document.createElement("mark");
  marker.textContent = finding.category === "spacing" ? "·".repeat(target.length) : finding.excerpt.slice(index, index + target.length);
  if (finding.category === "spacing") marker.title = `${target.length} spaces`;
  element.append(finding.excerpt.slice(0, index), marker, finding.excerpt.slice(index + target.length));
}

function selectFinding(finding, row) {
  pdfEls.issues.querySelector(".pdf-issue.active")?.classList.remove("active");
  pdfState.activeFinding = finding;
  pdfState.focusRect = null;
  const request = ++pdfState.focusRequest;
  row.classList.add("active");
  row.scrollIntoView({ block: "nearest" });
  updateFindingNavigation();
  goToPage(finding.page);
  if (finding.rect) {
    if (pdfState.focusZoomRestore === null) pdfState.focusZoomRestore = pdfState.zoom;
    pdfState.zoom = Math.max(1.8, pdfState.zoom);
    fitPdfPage();
    centerOnRect(finding.rect);
  }
  renderMarkers();
  if (finding.rect && finding.locator) {
    loadCharacterPage(finding.page).then((page) => {
      if (pdfState.focusRequest !== request || pdfState.activeFinding !== finding) return;
      pdfState.focusRect = locateFinding(page, finding);
      renderMarkers();
      if (pdfState.focusRect) centerOnRect(pdfState.focusRect);
    }).catch((error) => {
      if (pdfState.focusRequest === request) reportRendererError(error);
    });
  }
}

function clearFindingFocus() {
  pdfState.focusRequest++;
  pdfState.activeFinding = null;
  pdfState.focusRect = null;
  pdfEls.issues.querySelector(".pdf-issue.active")?.classList.remove("active");
  updateFindingNavigation();
  if (pdfState.focusZoomRestore !== null) {
    pdfState.zoom = pdfState.focusZoomRestore;
    pdfState.focusZoomRestore = null;
    fitPdfPage();
  }
  renderMarkers();
}

function loadCharacterPage(page) {
  const key = `${pdfState.payload.revision}:${page}`;
  if (!pdfState.characterPages.has(key)) {
    const url = `princeznoid://app/pdf-chars/${page}.json?revision=${pdfState.payload.revision}`;
    const request = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Could not locate text on PDF page ${page}.`);
      return response.json();
    }).catch((error) => { pdfState.characterPages.delete(key); throw error; });
    pdfState.characterPages.set(key, request);
  }
  return pdfState.characterPages.get(key);
}

function locateFinding(page, finding) {
  const target = Array.from(finding.locator.toLowerCase());
  const anchor = finding.rect;
  let closest = null;
  let closestDistance = Infinity;
  for (const line of page.lines || []) {
    const glyphs = line.glyphs || [];
    for (let index = 0; index <= glyphs.length - target.length; index++) {
      if (!target.every((letter, offset) => glyphs[index + offset].c.toLowerCase() === letter)) continue;
      const match = glyphs.slice(index, index + target.length);
      const x = Math.min(...match.map((glyph) => glyph.rect.x));
      const right = Math.max(...match.map((glyph) => glyph.rect.x + glyph.rect.width));
      const rect = { x, y: line.rect.y, width: Math.max(right - x, 1), height: line.rect.height };
      const dx = rect.x + rect.width / 2 - anchor.x - anchor.width / 2;
      const dy = rect.y + rect.height / 2 - anchor.y - anchor.height / 2;
      const distance = dx * dx + 9 * dy * dy;
      if (distance < closestDistance) { closest = rect; closestDistance = distance; }
    }
  }
  return closest;
}

function centerOnRect(rect) {
  const page = pdfState.page;
  requestAnimationFrame(() => {
    if (pdfState.page !== page || !pdfState.payload) return;
    const size = pdfState.payload.pdf.sizes[page - 1];
    if (!size) return;
    const stage = pdfEls.stage.getBoundingClientRect();
    const shell = pdfEls.shell.getBoundingClientRect();
    const targetX = stage.left + (rect.x + rect.width / 2) / size.width * stage.width;
    const targetY = stage.top + (rect.y + rect.height / 2) / size.height * stage.height;
    pdfEls.shell.scrollTo({
      left: pdfEls.shell.scrollLeft + targetX - shell.left - shell.width / 2,
      top: pdfEls.shell.scrollTop + targetY - shell.top - shell.height / 2,
      behavior: "smooth"
    });
  });
}

function renderMarkers() {
  pdfEls.overlays.replaceChildren();
  if (!pdfState.report || !pdfState.payload) return;
  const size = pdfState.payload.pdf.sizes[pdfState.page - 1];
  if (!size || !size.width || !size.height) return;
  const findings = pdfState.activeFinding?.page === pdfState.page
    ? [pdfState.activeFinding]
    : pdfState.report.findings.filter((finding) => finding.page === pdfState.page && !findingIsHidden(finding));
  for (const finding of findings) {
    const active = pdfState.activeFinding === finding;
    const rect = active && pdfState.focusRect ? pdfState.focusRect : finding.rect;
    if (!rect) continue;
    const marker = document.createElement("div");
    marker.className = `pdf-marker${active ? " active" : ""}${active && finding.locator && !pdfState.focusRect ? " approximate" : ""}`;
    marker.style.left = `${Math.max(0, 100 * rect.x / size.width)}%`;
    marker.style.top = `${Math.max(0, 100 * rect.y / size.height)}%`;
    marker.style.width = `${Math.min(100, 100 * rect.width / size.width)}%`;
    marker.style.height = `${Math.min(100, 100 * rect.height / size.height)}%`;
    marker.title = `${finding.title}${active && finding.locator && !pdfState.focusRect ? " (approximate)" : ""}`;
    pdfEls.overlays.append(marker);
  }
}

window.PdfProof = {
  open: openPdf,
  close: closePdf,
  turn: turnPdfPage,
  adjustZoom: adjustPdfZoom,
  showReport: showPdfReport,
  showScanError: showPdfScanError
};

window.ipc.postMessage(JSON.stringify({ command: "renderer-ready" }));
