import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class TextNode {
  constructor(value = "") { this.textContent = String(value); }
}

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    const classes=new Set();
    this.classList={toggle:(name,force)=>{const enabled=force??!classes.has(name);if(enabled)classes.add(name);else classes.delete(name);return enabled;},contains:name=>classes.has(name)};
    this.listeners = {};
    this.hidden = false;
    this.value = "";
    this.textNode = null;
  }

  set textContent(value) {
    this.textNode = new TextNode(value);
    this.children = [];
  }

  get textContent() {
    return `${this.textNode?.textContent ?? ""}${this.children.map(child => child.textContent).join(" ")}`;
  }

  get firstChild() { return this.textNode ?? this.children[0]; }
  get lastChild() { return this.children.at(-1); }

  append(...nodes) {
    this.children.push(...nodes);
    for (const node of nodes) node.parent = this;
  }

  replaceChildren(...nodes) {
    this.textNode = null;
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  focus() { document.activeElement = this; }
  scrollIntoView() {}
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  fire(name = "click", event = {}) {
    for (const listener of this.listeners[name] ?? []) listener(event);
    return this[`on${name}`]?.(event);
  }
  click() { if (!this.disabled) return this.fire(); }
}

function walk(node) {
  return [node, ...node.children.flatMap(walk)];
}

test("mounted drafts preserve labels and history and refuse invalid previews and budget suggestions", async () => {
  const html = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => {
    const node = new Element(match[1]);
    node.id = match[2];
    node.hidden = /\bhidden\b/.test(match[0]);
    return [node.id, node];
  }));
  const byId = selector => nodes.get(selector.replace(/^#/, ""));
  const querySelector = selector => {
    if (selector === "#change-panel input") return byId("#change-note");
    const attribute = selector.match(/^\[data-(member|item)-id="([^"]+)"\] input$/);
    if (attribute) {
      const key = `${attribute[1]}Id`;
      return [...nodes.values()].flatMap(walk).find(node => node.dataset[key] === attribute[2])
        ?.children.flatMap(walk).find(node => node.tagName === "INPUT");
    }
    const card = selector.match(/^\[data-(member)-id="([^"]+)"\]$/);
    if (card) return [...nodes.values()].flatMap(walk).find(node => node.dataset[card[1] + "Id"] === card[2]);
    const historical = selector.match(/^\[data-reuse-revision="(\d+)"\]$/);
    if (historical) return [...nodes.values()].flatMap(walk).find(node => node.dataset.reuseRevision === historical[1]);
    return byId(selector);
  };

  globalThis.document = Object.assign(new Element("document"), { querySelector, querySelectorAll: selector => {
    if (selector === "#member-editors [data-limit-impact]") return walk(byId("#member-editors")).filter(node => "limitImpact" in node.dataset);
    return [];
  }, createElement: tag => new Element(tag), activeElement: null });
  globalThis.CSS = { escape: value => value };
  globalThis.requestAnimationFrame = callback => callback();
  globalThis.window = Object.assign(new Element("window"), { alert() {}, confirm: () => true });

  await import("../app/app.mjs");
  byId("#start-example").click();
  byId("#begin-change").click();

  const memberCard = id => byId("#member-editors").children.find(node => node.dataset.memberId === id);
  const itemCard = id => byId("#item-editors").children.find(node => node.dataset.itemId === id);
  const nameInput = id => memberCard(id).children.filter(node => node.tagName === "LABEL")[0].children[0];
  const weightLabels = id => itemCard(id).children[1].children;
  const weightInputs = id => weightLabels(id).map(label => label.children[0]);
  const change = (input, value) => { input.value = value; input.fire("input"); };

  const originalTicketInputs = weightInputs("tickets");
  const originalCoachInputs = weightInputs("coach");
  const ashaName = nameInput("asha");
  ashaName.focus();
  change(ashaName, "Zoe");

  assert.equal(weightLabels("tickets")[0].firstChild.textContent, "Zoe shares");
  assert.equal(weightLabels("coach")[0].firstChild.textContent, "Zoe shares");
  assert.deepEqual(weightInputs("tickets"), originalTicketInputs);
  assert.deepEqual(weightInputs("coach"), originalCoachInputs);
  assert.equal(document.activeElement, ashaName);

  change(nameInput("ben"), "Asha");
  change(ashaName, "Ben");
  assert.deepEqual(
    weightLabels("tickets").slice(0, 2).map(label => label.firstChild.textContent),
    ["Ben shares", "Asha shares"]
  );

  byId("#add-item").click();
  change(nameInput("asha"), "Zoe");
  for (const item of byId("#item-editors").children) {
    assert.equal(item.children[1].children[0].firstChild.textContent, "Zoe shares");
  }

  // Reusing historical source inputs is a NEW amendment, never a history rollback.
  const coachUnit = itemCard("coach").children[0].children[1].children[0];
  change(coachUnit, "40.00");
  byId("#change-form").fire("submit", { preventDefault() {} });
  assert.match(byId("#revision-label").textContent, /^R2$/);
  assert.equal(byId("#total-label").textContent, "$200.00");
  byId("#member-results").children[0].lastChild.children[0].click();
  assert.equal(byId("#approval-label").textContent, "1 of 3");

  const firstEvent = byId("#history-list").children[0];
  const reuse = firstEvent.children.find(node => node.dataset.reuseRevision === "1");
  assert.ok(reuse, "older revisions offer an explicitly labelled draft action");
  reuse.click();
  assert.equal(byId("#change-panel").hidden, false);
  assert.match(byId("#draft-base").textContent, /current R2; reusing R1 inputs/);
  assert.equal(byId("#change-note").value, "Revisiting R1 inputs");
  assert.equal(Number(itemCard("coach").children[0].children[1].children[0].value), 60);

  // Cancelling the revived draft leaves the accepted R2 and its declaration alone.
  byId("#cancel-change").click();
  assert.equal(document.activeElement, reuse, "historical draft cancellation restores the action focus");
  assert.match(byId("#revision-label").textContent, /^R2$/);
  assert.equal(byId("#approval-label").textContent, "1 of 3");
  reuse.click();
  byId("#change-form").fire("submit", { preventDefault() {} });
  assert.match(byId("#revision-label").textContent, /^R3$/);
  assert.equal(byId("#total-label").textContent, "$220.00");
  assert.equal(byId("#approval-label").textContent, "0 of 3");
  const firstRow = byId("#member-results").children[0];
  assert.equal(firstRow.children[0].children[0].textContent, "Asha", "desktop name retained");
  const declarationToggle = firstRow.children[0].children[1];
  assert.equal(declarationToggle.textContent, "Asha", "phone declaration keeps the same identity");
  assert.equal(declarationToggle["aria-expanded"], "false", "new revision starts compact");
  declarationToggle.click();
  assert.equal(firstRow.dataset.expanded, "true");
  assert.equal(declarationToggle["aria-expanded"], "true");
  assert.equal(byId("#approval-label").textContent, "0 of 3", "opening details never records approval");
  declarationToggle.click();
  assert.equal(firstRow.dataset.expanded, "false");
  assert.equal(byId("#change-panel").hidden, true);


  assert.equal(byId("#history-list").children.length, 4);
  assert.equal(byId("#latest-change-heading").textContent.startsWith("R2 → R3"), true);
  const comparison = byId("#compare-from-revision");
  assert.equal(comparison.value, "2");
  assert.equal(comparison.children.length, 2);
  comparison.value = "1";
  comparison.fire("change");
  assert.equal(byId("#latest-change-heading").textContent.startsWith("R1 → R3"), true);
  assert.match(byId("#latest-change-summary").textContent, /Previous total \$220\.00 → current \$220\.00/);
  assert.equal(byId("#approval-label").textContent, "0 of 3", "comparison cannot grant approval");
  // A detached control from the previous workspace cannot bring in foreign history.
  byId("#start-example").click();
  assert.equal(byId("#change-panel").hidden, true);
  reuse.click();
  assert.equal(byId("#change-panel").hidden, true);
  assert.match(byId("#revision-label").textContent, /^R1$/);
  assert.equal(byId("#latest-change-panel").hidden, true, "new workspace clears old comparison");
  // Preview and Budget Rescue must refuse the same editable inputs as recording.
  // These controls execute the real application module, not a copied evaluator.
  byId("#begin-change").click();
  const blankName = nameInput("asha");
  change(blankName, "");
  assert.match(byId("#preview-body").textContent, /Draft is not valid yet:.*name/);
  byId("#find-budget-option").click();
  assert.match(byId("#budget-option").textContent, /No valid budget alternative.*name/);
  assert.equal(byId("#budget-option").children.some(node => node.tagName === "BUTTON"), false);
  byId("#change-form").fire("submit", { preventDefault() {} });
  assert.match(byId("#revision-label").textContent, /^R1$/);
  assert.equal(byId("#history-list").children.length, 1);
  assert.equal(byId("#total-label").textContent, "$220.00");
  assert.equal(blankName.value, "", "failed recording preserves the invalid field for correction");

  change(blankName, "Asha");
  const limits = memberCard("asha").children.filter(node => node.tagName === "LABEL")[1].children[0];
  change(limits, "");
  assert.match(byId("#preview-body").textContent, /Draft is not valid yet:.*budgetMinor/);
  byId("#find-budget-option").click();
  assert.match(byId("#budget-option").textContent, /No valid budget alternative.*budgetMinor/);
  change(limits, "90.00");

  const ticketWeights = weightInputs("tickets");
  for (const input of ticketWeights) change(input, String(Number.MAX_SAFE_INTEGER));
  assert.match(byId("#preview-body").textContent, /Draft is not valid yet:.*weight/);
  byId("#find-budget-option").click();
  assert.match(byId("#budget-option").textContent, /No valid budget alternative.*weight/);
  assert.equal(byId("#history-list").children.length, 1);

  ticketWeights.forEach((input, index) => change(input, index === 1 ? "2" : "1"));
  assert.match(byId("#preview-body").textContent, /Draft total \$220\.00; current total \$220\.00/);
  byId("#find-budget-option").click();
  assert.match(byId("#budget-option").textContent, /already within their spending limit/);
  byId("#change-form").fire("submit", { preventDefault() {} });
  assert.match(byId("#revision-label").textContent, /^R2$/);
  assert.equal(byId("#total-label").textContent, "$220.00");
  assert.equal(byId("#history-list").children.length, 2);

});
