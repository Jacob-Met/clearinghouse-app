import test from "node:test";
import assert from "node:assert/strict";
import { amendProject, approveProject, createProject, expectedState, exportProject, importProject, replayProject } from "../app/core.mjs";
import { changeBriefAgainstRevision, latestChangeBrief, changeBriefHtml } from "../app/change-brief.mjs";
import { at, creation, revision } from "./fixtures.mjs";

const seeded = () => createProject(creation());
const change = (project, newRevision, eventId = `change-${newRevision.ordinal}`) => amendProject(project, expectedState(project), { eventId, at: at(newRevision.ordinal + 9), revision: newRevision });
const approveAll = (project, prefix) => {
  for (const [index, memberId] of replayProject(project).current.members.map(m => m.id).entries()) {
    project = approveProject(project, expectedState(project), { eventId: `${prefix}-${index}`, at: at(index + 18), memberId });
  }
  return project;
};

test("first revision deliberately has no change comparison and cannot export one", () => {
  assert.equal(latestChangeBrief(replayProject(seeded())), null);
  assert.equal(latestChangeBrief(null), null);
  assert.throws(() => changeBriefHtml(null), /two revisions/);
});

test("recorded approvals are retired, and every change stays inspectable", () => {
  let project = approveAll(seeded(), "r1");
  const next = revision(2); next.items[0].quantity = 5;
  project = change(project, next);
  const brief = latestChangeBrief(replayProject(project));
  assert.equal(brief.before.totalMinor, 22000);
  assert.equal(brief.after.totalMinor, 26000);
  assert.equal(brief.deltaMinor, 4000);
  assert.equal(brief.retiredActiveDeclarations, 3);
  assert.equal(brief.currentDeclarations, 0);
  assert.equal(brief.requiredDeclarations, 3);
  assert.equal(brief.feasible, false);
  assert.deepEqual(brief.members.map(m => [m.id, m.previousMinor, m.currentMinor, m.currentDeclaration]),
    [["asha",6000,7000,false],["ben",10000,12000,false],["chen",6000,7000,false]]);
  assert.deepEqual(brief.items.map(i => [i.id, i.status, i.differences]), [["tickets","changed",["quantity"]],["coach","unchanged",[]]]);
  assert.equal(brief.members.find(m => m.id === "ben").currentStatus, "Over by $10.00");
  assert.equal(replayProject(project).project.events.length, 5);
});

test("name/limit/weight-only changes are distinguishable from unchanged prices", () => {
  const next = revision(2);
  next.members[0].name = "Asha, organizer";
  next.members[0].budgetMinor = 10000;
  next.items[0].weights = [{ memberId:"chen",units:1 },{memberId:"ben",units:1},{memberId:"asha",units:2}];
  const brief = latestChangeBrief(replayProject(change(seeded(), next)));
  assert.equal(brief.deltaMinor,0);
  assert.equal(brief.members[0].renamed,true);
  assert.equal(brief.members[0].limitChanged,true);
  assert.equal(brief.members[0].previousName,"Asha");
  assert.deepEqual(brief.items[0].differences,["split weights"]);
  assert.deepEqual(brief.items[1].differences,[]);
});

test("joins, exits and item additions/removals use stable IDs and preserve zero bases", () => {
  const next = revision(2,{
    members:[{id:"asha",name:"Asha",budgetMinor:9000},{id:"dia",name:"Dia",budgetMinor:12000}],
    items:[{id:"room",label:"Room",unitMinor:9000,quantity:1,weights:[{memberId:"asha",units:1},{memberId:"dia",units:2}]}]
  });
  const brief=latestChangeBrief(replayProject(change(seeded(),next)));
  assert.deepEqual(brief.members.map(m=>[m.id,m.transition,m.previousMinor,m.currentMinor]),[
    ["asha","continuing",6000,3000],["dia","joined",0,6000],["ben","departed",10000,0],["chen","departed",6000,0]
  ]);
  assert.deepEqual(brief.items.map(i=>[i.id,i.status,i.deltaMinor]),[["room","added",9000],["tickets","removed",-16000],["coach","removed",-6000]]);
  assert.equal(brief.deltaMinor,-13000);
  assert.match(changeBriefHtml(brief),/Departed; no new obligation/);
});

test("A→B→A content restoration does not restore historical declarations", () => {
  let project = approveAll(seeded(),"prior");
  const broken = revision(2); broken.items[0].quantity=5;
  project=change(project,broken);
  project=change(project,revision(3));
  const state = replayProject(project), brief=latestChangeBrief(state);
  assert.equal(state.approvals.length,0);
  assert.equal(brief.retiredActiveDeclarations,0);
  assert.equal(brief.currentDeclarations,0);
  assert.equal(brief.before.ordinal,2);
  assert.equal(brief.after.ordinal,3);
  assert.equal(brief.after.totalMinor,22000);
  assert.match(changeBriefHtml(brief),/Every revision requires fresh explicit declarations/);
});

test("brief updates after approvals but does not mutate or append source history", () => {
  const initial = change(seeded(),revision(2));
  const stableSource = exportProject(initial);
  const brief0 = latestChangeBrief(replayProject(initial));
  assert.equal(brief0.retiredActiveDeclarations,0);
  assert.equal(brief0.currentDeclarations,0);
  assert.equal(exportProject(initial),stableSource);
  let current = approveProject(initial,expectedState(initial),{eventId:"now-asha",at:at(28),memberId:"asha"});
  assert.equal(latestChangeBrief(replayProject(current)).currentDeclarations,1);
  const reopened = importProject(exportProject(current));
  assert.deepEqual(latestChangeBrief(replayProject(reopened)),latestChangeBrief(replayProject(current)));
  assert.equal(replayProject(current).project.events.length,3);
  assert.equal(latestChangeBrief(replayProject(initial)).currentDeclarations,0);
});

test("HTML report escapes adversarial labels, includes policy boundary and remains script-free", () => {
  const evil=`<img src=x onerror=alert(42)>& ' \"`;
  const changed=revision(2);changed.members[0].name=evil;changed.items[0].label=evil;changed.note=evil;
  const brief=latestChangeBrief(replayProject(change(seeded(),changed)));
  const html=changeBriefHtml(brief);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(42)&gt;&amp; &#39; &quot;"));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes('<link'));
  assert.ok(!html.includes('src="http'));
  assert.ok(html.includes("default-src 'none'"));
  assert.match(html,/does not authenticate any person/);
  assert.match(html,/not signed/);
  assert.match(html,/Project ID: project-1/);
});

test("large safe integer money remains precise in after/before/delta strings", () => {
  const huge=revision(2,{
    items:[{id:"heavy",label:"Expensive item",unitMinor:Number.MAX_SAFE_INTEGER,quantity:1,
      weights:[{memberId:"asha",units:1},{memberId:"ben",units:0},{memberId:"chen",units:0}]}]
  });
  const brief=latestChangeBrief(replayProject(change(seeded(),huge)));
  assert.equal(brief.after.totalMinor,Number.MAX_SAFE_INTEGER);
  assert.equal(brief.deltaMinor,Number.MAX_SAFE_INTEGER-22000);
  assert.match(changeBriefHtml(brief),/\$90,071,992,547,409\.91/);
  assert.equal(brief.feasible,false);
});

test("report is stable under participant and weight order permutations", () => {
  const a=revision(2), b=revision(2);
  a.items[0].quantity=5;b.items[0].quantity=5;
  b.items.forEach(item=>item.weights.reverse());
  // Member order is source presentation order; output comparisons use stable IDs.
  const aBrief=latestChangeBrief(replayProject(change(seeded(),a)));
  const bBrief=latestChangeBrief(replayProject(change(seeded(),b)));
  assert.deepEqual(aBrief.items,bBrief.items);
  assert.deepEqual(aBrief.members,bBrief.members);
});

test("cumulative comparison remains exact when intermediate price and approvals changed", () => {
  let project = approveAll(seeded(), "original");
  const increased = revision(2); increased.items[0].quantity = 5;
  project = change(project, increased);
  project = change(project, revision(3));
  const original = exportProject(project), state = replayProject(project);
  const adjacent = latestChangeBrief(state), cumulative = changeBriefAgainstRevision(state, 1);
  assert.equal(adjacent.before.ordinal, 2);
  assert.equal(adjacent.deltaMinor, -4000);
  assert.equal(cumulative.before.ordinal, 1);
  assert.equal(cumulative.after.ordinal, 3);
  assert.equal(cumulative.deltaMinor, 0);
  assert.equal(cumulative.retiredActiveDeclarations, 3);
  assert.equal(cumulative.currentDeclarations, 0);
  assert.deepEqual(cumulative.members.map(member => member.deltaMinor), [0, 0, 0]);
  assert.match(changeBriefHtml(cumulative), /R1 → R3/);
  assert.match(changeBriefHtml(cumulative), /active declaration\(s\) on R1 remain historical/);
  assert.deepEqual(changeBriefAgainstRevision(replayProject(importProject(original)), 1), cumulative);
  assert.equal(exportProject(project), original, "comparison never mutates events");
  for (const invalid of [0, 3, 4, 1.5, "1", Number.NaN])
    assert.throws(() => changeBriefAgainstRevision(state, invalid), RangeError);
});
