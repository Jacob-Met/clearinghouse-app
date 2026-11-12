import test from "node:test";
import assert from "node:assert/strict";
import { proposeBudgetRescue } from "../app/budget-rescue.mjs";
import { allocateItem, createProject, evaluateRevision, replayProject } from "../app/core.mjs";
import { at, revision } from "./fixtures.mjs";

const person = (id, budgetMinor) => ({ id, name: id, budgetMinor });
const product = (id, unitMinor, quantity, rows) => ({
  id, label: id, unitMinor, quantity,
  weights: rows.map(([memberId, units]) => ({ memberId, units }))
});

test("already feasible plans need no change", () => {
  const actual = proposeBudgetRescue(revision());
  assert.equal(actual.status, "already-feasible");
  assert.equal(actual.movedMinor, 0);
});

test("the $180 withdrawal scenario has a real $10 combined shortfall", () => {
  const r = revision(1, {
    members: [person("asha", 9000), person("chen", 8000)],
    items: [
      product("tickets", 4000, 3, [["asha", 1], ["chen", 2]]),
      product("coach", 6000, 1, [["asha", 1], ["chen", 1]])
    ]
  });
  const snapshot = structuredClone(r);
  const actual = proposeBudgetRescue(r);
  assert.equal(actual.status, "unfunded");
  assert.equal(actual.shortfallMinor, 1000);
  assert.deepEqual(r, snapshot);
});

test("funded draft rescues exactly the necessary cents and passes production replay", () => {
  const r = revision(1);
  r.members.find(m => m.id === "chen").budgetMinor = 5000;
  const unchanged = structuredClone(r);
  const actual = proposeBudgetRescue(r);
  assert.equal(actual.status, "suggestion");
  assert.equal(actual.movedMinor, 1000);
  assert.equal(actual.before.totalMinor, actual.after.totalMinor);
  assert.equal(actual.after.feasible, true);
  assert.equal(actual.after.agreementRecorded, false);
  assert.equal(actual.after.executedMinor, 0);
  assert.deepEqual(r, unchanged);
  const received = replayProject(createProject({ projectId: "new-group", title: "Test", eventId: "e1", at: at(0), revision: actual.revision }));
  assert.deepEqual(received.evaluation.members.map(m => [m.id, m.amountMinor]), actual.after.members.map(m => [m.id, m.amountMinor]));
});

test("zero-price items retain positive original weights", () => {
  const r = revision(1, {
    members: [person("a", 900), person("b", 300)],
    items: [
      product("paid", 1000, 1, [["a", 1], ["b", 3]]),
      product("free", 0, 2, [["a", 4], ["b", 0]])
    ]
  });
  const output = proposeBudgetRescue(r);
  assert.equal(output.status, "suggestion");
  assert.deepEqual(output.revision.items[1].weights, r.items[1].weights);
});

test("very large safe-integer prices do not overflow aggregate budgets", () => {
  const n = 8_000_000_000_000_000;
  const r = revision(1, {
    members: [person("a", n), person("b", n)],
    items: [product("large", n, 1, [["a", 1], ["b", n - 1]])]
  });
  const output = proposeBudgetRescue(r);
  assert.equal(output.status, "already-feasible");
  // Make b unable to pay; a can absorb the full item with exact cents.
  r.members[1].budgetMinor = 0;
  const moved = proposeBudgetRescue(r);
  assert.equal(moved.status, "suggestion");
  assert.equal(moved.movedMinor, n - 1);
  assert.deepEqual(moved.after.members.map(m => m.amountMinor), [n, 0]);
});

test("seeded varied plans conserve cents, never mutate input, and produce valid replay", () => {
  let seed = 0xc0ffee;
  const rand = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  for (let cycle = 0; cycle < 1000; cycle += 1) {
    const n = 1 + rand(8), count = 1 + rand(8);
    const ids = Array.from({ length: n }, (_, i) => `m${i}`);
    const items = Array.from({ length: count }, (_, i) =>
      product(`item${i}`, rand(2000), 1 + rand(3), ids.map(id => [id, rand(40)])));
    for (const item of items) if (item.weights.every(w => w.units === 0)) item.weights[0].units = 1;
    const r = revision(1, { members: ids.map(id => person(id, rand(3500))), items });
    const prior = evaluateRevision(r), snapshot = structuredClone(r);
    const output = proposeBudgetRescue(r);
    assert.deepEqual(r, snapshot, `mutated cycle ${cycle}`);
    const sumBudget = r.members.reduce((sum, m) => sum + BigInt(m.budgetMinor), 0n);
    if (prior.feasible) assert.equal(output.status, "already-feasible", `cycle ${cycle}`);
    else if (sumBudget < BigInt(prior.totalMinor)) {
      assert.equal(output.status, "unfunded", `cycle ${cycle}`);
      assert.equal(output.shortfallMinor, Number(BigInt(prior.totalMinor) - sumBudget));
    } else if (output.status === "participation-blocked") {
      assert.ok(output.shortfallMinor > 0);
      assert.equal(output.requiredMinor - output.availableMinor, output.shortfallMinor);
    } else {
      assert.equal(output.status, "suggestion", `cycle ${cycle}`);
      assert.equal(output.after.feasible, true);
      assert.equal(output.after.totalMinor, prior.totalMinor);
      assert.ok(output.movedMinor >= prior.members.reduce((s, m) => s + m.overMinor, 0));
      for (let i=0;i<r.items.length;i++) for(let j=0;j<r.items[i].weights.length;j++)
        if(r.items[i].weights[j].units===0) assert.equal(output.revision.items[i].weights[j].units,0);
      const loaded = replayProject(createProject({ projectId: "trial", title: "Trial", eventId: "created", at: at(0), revision: output.revision }));
      assert.equal(loaded.evaluation.feasible, true);
    }
  }
});

test("excluded members cannot fund a purchase despite surplus total budget",()=>{
  const r=revision(1,{members:[person("a",20),person("b",100)],items:[product("ticket",60,1,[["a",1],["b",0]])]});
  const result=proposeBudgetRescue(r);
  assert.equal(result.status,"participation-blocked");
  assert.deepEqual(result.itemIds,["ticket"]);
  assert.deepEqual(result.memberIds,["a"]);
  assert.equal(result.requiredMinor,60);assert.equal(result.availableMinor,20);assert.equal(result.shortfallMinor,40);
  assert.equal(result.revision,undefined);
});

test("joint item bottleneck is identified even when each item alone fits",()=>{
  const r=revision(1,{members:[person("a",50),person("b",100)],items:[
    product("ticket",40,1,[["a",1],["b",0]]),product("meal",40,1,[["a",1],["b",0]])]});
  const result=proposeBudgetRescue(r);
  assert.equal(result.status,"participation-blocked");
  assert.deepEqual(result.itemIds,["meal","ticket"]);assert.deepEqual(result.memberIds,["a"]);
  assert.equal(result.shortfallMinor,30);
});

test("indirect exchange can rescue a plan while preserving exclusions",()=>{
  const r=revision(1,{members:[person("a",30),person("b",60),person("c",50)],items:[
    product("ab",60,1,[["a",5],["b",1],["c",0]]),
    product("bc",60,1,[["a",0],["b",5],["c",1]])]});
  const result=proposeBudgetRescue(r);
  assert.equal(result.status,"suggestion");
  assert.equal(result.movedMinor,40); // a -> b on ab, b -> c on bc
  assert.deepEqual(result.after.members.map(m=>m.amountMinor),[30,60,30]);
  assert.equal(result.revision.items[0].weights[2].units,0);
  assert.equal(result.revision.items[1].weights[0].units,0);
});

test("constrained optimum agrees with exhaustive independent tiny-plan enumeration",()=>{
  let seed=13579;
  const rand=n=>{seed=(seed*1664525+1013904223)>>>0;return seed%n;};
  for(let trial=0;trial<200;trial++){
    const members=["a","b","c"].map(id=>person(id,rand(9)));
    const items=Array.from({length:3},(_,i)=>{
      const rows=members.map(m=>[m.id,rand(3)]);
      if(rows.every(r=>r[1]===0))rows[0][1]=1;
      return product("i"+i,1+rand(4),1,rows);
    });
    const r=revision(1,{members,items});
    const choices=items.map(item=>{
      const old=allocateItem(item).map(a=>a.minor), list=[];
      for(let a=0;a<=item.unitMinor;a++)for(let b=0;b<=item.unitMinor-a;b++){
        const row=[a,b,item.unitMinor-a-b];
        if(row.some((v,i)=>v>0&&item.weights[i].units===0))continue;
        list.push({row,cost:row.reduce((s,v,i)=>s+Math.max(0,v-old[i]),0)});
      }
      return list;
    });
    let optimum=Infinity;
    for(const a of choices[0])for(const b of choices[1])for(const c of choices[2])
      if(members.every((m,i)=>a.row[i]+b.row[i]+c.row[i]<=m.budgetMinor))
        optimum=Math.min(optimum,a.cost+b.cost+c.cost);
    const actual=proposeBudgetRescue(r);
    if(optimum===Infinity)assert.ok(["unfunded","participation-blocked"].includes(actual.status),"trial "+trial);
    else assert.equal(actual.movedMinor,optimum,"trial "+trial);
  }
});
