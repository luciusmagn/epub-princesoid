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
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  dispatch(name) { this.listeners.get(name)?.({ preventDefault() {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  querySelector() { return null; }
  setCustomValidity() {}
  reportValidity() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
}

const elements = new Map();
const storage = new Map();
const messages = [];
const context = vm.createContext({
  showToast() {},
  document: {
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
vm.runInContext('pdfState.payload = { accepted_defaults: ["braiins"], revision: 1 }; addAllowedWord(" CustomTerm ");', context);
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

console.log("PDF UI geometry and allowed-word checks passed");
