import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceController } from "../app/controller.mjs";
import { exportProject } from "../app/core.mjs";
import { at, creation, revision } from "./fixtures.mjs";

function workspace() { const controller = new WorkspaceController(); controller.replaceWithNew(creation()); return controller; }

test("pending import loses custody after approval, withdrawal, or replacement", () => {
  for (const mutation of ["approve", "withdraw", "replace"]) {
    const controller = workspace(); const token = controller.beginImport(); const parsed = controller.parseImport(controller.exportText());
    if (mutation === "approve") controller.approve(controller.captureAction(), { eventId: "later", at: at(8), memberId: "asha" });
    else if (mutation === "withdraw") {
      controller.approve(controller.captureAction(), { eventId: "approval", at: at(7), memberId: "asha" });
      controller.withdraw(controller.captureAction(), { eventId: "withdrawal", at: at(8), memberId: "asha" });
    }
    else controller.replaceWithNew({ ...creation(), projectId: "project-2", eventId: "new-event" });
    const before = controller.exportText();
    assert.throws(() => controller.adoptImport(token, parsed, true), error => error.code === "stale_import");
    assert.equal(controller.exportText(), before);
  }
});

test("a newer invalid import attempt prevents fallback to an older valid read", () => {
  const controller = workspace(); const validToken = controller.beginImport(); const parsed = controller.parseImport(controller.exportText());
  controller.beginImport();
  assert.throws(() => controller.parseImport("{broken"), error => error.code === "invalid_json");
  const before = controller.exportText();
  assert.throws(() => controller.adoptImport(validToken, parsed, true), error => error.code === "stale_import");
  assert.equal(controller.exportText(), before);
});

test("editing an unsaved draft retires a pending import without staling the draft action", () => {
  const controller = workspace(); const action = controller.captureAction();
  const token = controller.beginImport(); const parsed = controller.parseImport(controller.exportText());
  controller.touchDraft();
  assert.throws(() => controller.adoptImport(token, parsed, true), error => error.code === "stale_import");
  controller.approve(action, { eventId: "draft-action-still-owned", at: at(9), memberId: "asha" });
  assert.deepEqual(controller.state.approvals, ["asha"]);
});

test("cancelled replacement consumes its authority", () => {
  const controller = workspace(); const token = controller.beginImport(); const parsed = controller.parseImport(controller.exportText());
  const before = controller.exportText();
  assert.deepEqual(controller.adoptImport(token, parsed, false), { adopted: false, reason: "cancelled" });
  assert.throws(() => controller.adoptImport(token, parsed, true), error => error.code === "stale_import");
  assert.equal(controller.exportText(), before);
});

test("same project IDs do not defeat workspace generation fence", () => {
  const controller = workspace(); const action = controller.captureAction();
  const text = controller.exportText(); const token = controller.beginImport(); const parsed = controller.parseImport(text);
  controller.adoptImport(token, parsed, true);
  assert.throws(() => controller.approve(action, { eventId: "stale-event", at: at(9), memberId: "asha" }), error => error.code === "stale_session");
});

test("failed parse is atomic", () => {
  const controller = workspace(); const before = controller.exportText();
  assert.throws(() => controller.parseImport(JSON.stringify({ format: "wrong" })));
  assert.equal(controller.exportText(), before);
});
