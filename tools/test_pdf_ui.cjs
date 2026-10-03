const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.open = false;
    this.clientWidth = 900;
    this.clientHeight = 700;
    this.scrollLeft = 0;
    this.scrollTop = 0;
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name, event = {}) { this.listeners.get(name)?.({ preventDefault() {}, ...event }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  querySelector(selector) {
    const id = selector.match(/^\[data-finding-id="(\d+)"\]$/)?.[1];
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (id && child.dataset.findingId === id) return child;
      const match = child.querySelector(selector);
      if (match) return match;
    }
    return null;
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.offsetWidth, height: this.offsetHeight }; }
  get offsetWidth() { return Number.parseFloat(this.style.width) || this.clientWidth; }
  get offsetHeight() { return Number.parseFloat(this.style.height) || this.clientHeight; }
  scrollTo({ left = 0, top = 0 }) { this.scrollLeft = left; this.scrollTop = top; }
  scrollIntoView() {}
  setCustomValidity() {}
  reportValidity() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}

const elements = new Map();
const storage = new Map();
const messages = [];
const documentListeners = new Map();
const context = vm.createContext({
  showToast() {},
  requestAnimationFrame(callback) { callback(); },
  document: {
    body: { dataset: { document: "pdf" } },
    addEventListener(name, listener) { documentListeners.set(name, listener); },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, new Element());
      return elements.get(selector);
    },
    createElement() { return new Element(); },
    createDocumentFragment() { return new Element(); }
  },
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); }
  },
  window: { ipc: { postMessage(message) { messages.push(JSON.parse(message)); } } }
});

vm.runInContext(fs.readFileSync("assets/pdf-ui.js", "utf8"), context);

const page = {
  lines: [{
    rect: { x: 10, y: 20, width: 50, height: 10 },
    glyphs: [
      { c: "a", rect: { x: 10, y: 21, width: 3, height: 8 } },
      { c: " ", rect: { x: 13, y: 28, width: 3, height: 0 } },
      { c: " ", rect: { x: 16, y: 28, width: 3, height: 0 } },
      { c: "b", rect: { x: 19, y: 21, width: 5, height: 8 } }
    ]
  }]
};
const finding = { locator: "  ", rect: { x: 15, y: 20, width: 4, height: 10 } };
const located = vm.runInContext(`locateFinding(${JSON.stringify(page)}, ${JSON.stringify(finding)})`, context);
assert.deepEqual(JSON.parse(JSON.stringify(located)), { x: 13, y: 20, width: 6, height: 10 });

assert.equal(vm.runInContext('normalizeAllowedWord(" Frontend ")', context), "frontend");
assert.equal(vm.runInContext('normalizeAllowedWord("two words")', context), null);
vm.runInContext(`pdfState.payload = {
  path: "/test.pdf", accepted_defaults: ["braiins"], revision: 1,
  pdf: { page_count: 2, labels: ["1", "2"], sizes: [{ width: 612, height: 792 }, { width: 612, height: 792 }] }
}; addAllowedWord(" CustomTerm ");`, context);
assert.equal(storage.get("princeznoid-allowed-words"), '["customterm"]');
vm.runInContext('pdfEls.wordSearch.value = "custom"; renderAllowedWords();', context);
assert.equal(elements.get("#pdf-word-count").textContent, "1 / 2");
elements.get("#pdf-words-open").dispatch("click");
assert.equal(elements.get("#pdf-words-dialog").open, true);
assert.equal(elements.get("#pdf-word-search").focused, true);
elements.get("#pdf-words-close").dispatch("click");
assert.equal(elements.get("#pdf-words-dialog").open, false);
vm.runInContext('pdfEls.language.value = "en"; requestPdfScan();', context);
assert.deepEqual(messages.at(-1), { command: "scan-pdf", language: "en", accepted_words: ["customterm"] });

const spacing = { id: 1, page: 1, category: "spacing", title: "Double space", excerpt: "two  spaces", locator: "  ", rect: null };
const spelling = { id: 2, page: 2, category: "spelling", title: "Typo", excerpt: "mispellt", locator: "mispellt", rect: null };
context.testReport = { language: "en", findings: [spacing, spelling] };
context.testSpacing = spacing;
context.testSpelling = spelling;
const run = (script) => vm.runInContext(script, context);
run('pdfState.reviewHistory = []; pdfEls.filter.value = "all"; showPdfReport(testReport); ignoreFinding(testSpacing); ignoreFinding(testSpelling);');
assert.equal(run("pdfState.visibleFindings.length"), 0);
assert.equal(elements.get("#pdf-undo").disabled, false);
elements.get("#pdf-undo").dispatch("click");
assert.equal(run("pdfState.visibleFindings.length"), 1);
assert.equal(run("pdfState.activeFinding.id"), 2);
elements.get("#pdf-undo").dispatch("click");
assert.equal(run("pdfState.visibleFindings.length"), 2);
assert.equal(run("pdfState.activeFinding.id"), 1);
assert.equal(storage.get("princeznoid-ignored:/test.pdf"), "[]");
assert.equal(elements.get("#pdf-undo").disabled, true);

run('addAllowedWord("mispellt");');
assert.equal(run("pdfState.visibleFindings.length"), 1);
const beforeUndo = messages.length;
run("undoReviewAction();");
assert.equal(run("pdfState.visibleFindings.length"), 2);
assert.equal(run("pdfState.activeFinding.id"), 2);
assert.equal(messages.length, beforeUndo, "Undo should restore a locally hidden finding without rescanning");

run('addAllowedWord("mispellt"); requestPdfScan(); showPdfReport({ language: "en", findings: [testSpacing] }); undoReviewAction();');
assert.equal(messages.at(-1).accepted_words.includes("mispellt"), false);
assert.equal(run("pdfState.restoredFinding.id"), 2);
run("showPdfReport(testReport);");
assert.equal(run("pdfState.activeFinding.id"), 2, "Undo should restore the selected finding after a rescan");

run('addAllowedWord("mispellt"); removeAllowedWord("mispellt");');
const historyLength = run("pdfState.reviewHistory.length");
documentListeners.get("keydown")({ ctrlKey: true, key: "z", target: { closest() { return {}; } }, preventDefault() { assert.fail("Text-field undo must remain native"); } });
assert.equal(run("pdfState.reviewHistory.length"), historyLength);
documentListeners.get("keydown")({ metaKey: true, key: "z", target: { closest() { return null; } }, preventDefault() {} });
assert.equal(run('pdfState.allowedWords.has("mispellt")'), true);
assert.equal(messages.at(-1).accepted_words.includes("mispellt"), true);
elements.get("#pdf-words-undo").dispatch("click");
assert.equal(run('pdfState.allowedWords.has("mispellt")'), false);

run('pdfState.activeFinding = null; setPdfZoom("1");');
assert.equal(elements.get("#pdf-stage").style.width, "816px");
assert.equal(elements.get("#pdf-stage").style.height, "1056px");
assert.equal(elements.get("#pdf-zoom").value, "1");
run('setPdfZoom("3");');
assert.equal(elements.get("#pdf-stage").style.width, "2448px");
assert.match(elements.get("#pdf-page-image").src, /\/pdf-page\/2\/288\.png\?/);
assert.equal(elements.get("#pdf-zoom-in").disabled, true);
run('setPdfZoom("width");');
assert.equal(elements.get("#pdf-stage").style.width, "876px");
run('setPdfZoom("page");');
assert.ok(Number.parseFloat(elements.get("#pdf-stage").style.height) <= 658);
run("setPdfZoom(100); setPdfZoom(-100);");
assert.equal(run("pdfState.zoom"), 0.25);

console.log("PDF UI geometry, review undo, allowed-word and zoom checks passed");
