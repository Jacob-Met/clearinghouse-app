import test from "node:test";
import assert from "node:assert/strict";
import {BrowserWorkspaceStore, parseSavedWorkspace, exportPortableWorkspace, parsePortableWorkspace} from "../app/workspace-recovery.mjs";

class Storage {
  data=new Map(); fail=false;
  get length(){return this.data.size}
  key(i){return [...this.data.keys()][i]}
  getItem(k){return this.data.get(k) ?? null}
  setItem(k,v){if(this.fail)throw new Error("Browser quota exhausted");this.data.set(k,v)}
  removeItem(k){this.data.delete(k)}
}
class Locks {
  held=new Set();
  async request(key, options, callback) {
    if(this.held.has(key))return callback(null);
    this.held.add(key);
    try{return await callback({name:key})}finally{this.held.delete(key)}
  }
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const workspace=value=>({project:null,draft:{creating:true,revision:{members:[],items:[]},fields:[{key:"amount",value}]}});
test("a tab holds its saved workspace while another tab can preserve a separate edit",async()=>{
  const storage=new Storage(),locks=new Locks();
  let serial=0;const id=()=>String(++serial);
  const a=new BrowserWorkspaceStore(storage,locks,id),b=new BrowserWorkspaceStore(storage,locks,id);
  const first=await a.claim();assert.equal(first.acquired,true);
  a.save(workspace("12.405"));
  assert.equal((await b.claim(first.key)).acquired,false);
  assert.equal(b.read(first.key).workspace.draft.fields[0].value,"12.405");
  const separate=await b.claim();assert.notEqual(separate.key,first.key);
  b.save(workspace("18.90"));a.save(workspace("13.405"));
  assert.equal(a.list().length,2);
  assert.equal(a.read(first.key).workspace.draft.fields[0].value,"13.405");
  assert.equal(b.read(separate.key).workspace.draft.fields[0].value,"18.90");
  a.release();b.release();await tick();
  assert.equal((await b.claim(first.key)).record.workspace.draft.fields[0].value,"13.405");
  assert.throws(()=>a.save(workspace("lost update")),/not saving/);
  b.release();await tick();
});
test("a failed browser write retains the last saved copy and never advances its stamp",async()=>{
  const storage=new Storage(),locks=new Locks(),store=new BrowserWorkspaceStore(storage,locks);
  const claim=await store.claim();
  const original=store.save(workspace("7.20"));
  storage.fail=true;
  assert.throws(()=>store.save(workspace("9.40")),/quota/);
  assert.equal(store.stamp,original.stamp);
  assert.equal(parseSavedWorkspace(storage.getItem(claim.key)).workspace.draft.fields[0].value,"7.20");
  store.release();await tick();
});

test("organizer access survives a consented copy and is bound to its recorded plan",async()=>{
  const storage=new Storage(),locks=new Locks(),a=new BrowserWorkspaceStore(storage,locks);
  const project=JSON.stringify({projectId:"group-one"});
  const sharedOrganizer={projectId:"group-one",ownerToken:"a".repeat(43)};
  const {key}=await a.claim();
  a.save({project,draft:null,sharedOrganizer});
  a.release();await tick();
  const b=new BrowserWorkspaceStore(storage,locks);
  const restored=await b.claim(key);
  assert.deepEqual(restored.record.workspace.sharedOrganizer,sharedOrganizer);
  assert.throws(()=>b.save({project,draft:null,sharedOrganizer:{...sharedOrganizer,projectId:"other"}}),/does not match/);
  assert.throws(()=>b.save({project,draft:null,sharedOrganizer:{...sharedOrganizer,ownerToken:"bad"}}),/does not match/);
  assert.throws(()=>b.save({project:null,draft:workspace("").draft,sharedOrganizer}),/does not match/);
  b.remove();await tick();
  assert.equal(storage.length,0,"removing the browser copy removes its organizer access too");
});

test("malformed saved alternatives are refused without replacing the previous browser copy",async()=>{
  const storage=new Storage(),locks=new Locks(),store=new BrowserWorkspaceStore(storage,locks);
  const {key}=await store.claim();
  const previous=store.save(workspace("7.20"));
  assert.throws(()=>store.save({...workspace("9.00"),scenarios:[{id:1}]}),/purchase options/);
  assert.equal(store.read(key).stamp,previous.stamp);
  assert.equal(store.read(key).workspace.draft.fields[0].value,"7.20");
  store.release();await tick();
});


test("portable unfinished work preserves invalid fields but excludes organizer access",()=>{
  const draft={creating:true,revision:{members:[{id:"a",name:"A"}],items:[{id:"i",label:"Tickets",weights:[]}]},
    base:{generation:1,session:1},fromOrdinal:null,title:"Trip",note:"Not yet agreed",goal:"Help",
    fields:[{key:"item:i:unit",value:"12.405"}]};
  const raw=exportPortableWorkspace({project:null,draft,sharedOrganizer:{projectId:"secret-group",ownerToken:"x".repeat(43)}});
  assert.ok(!raw.includes("ownerToken")&&!raw.includes("secret-group"));
  assert.deepEqual(parsePortableWorkspace(raw),{project:null,draft});
  const altered=JSON.parse(raw);altered.workspace.sharedOrganizer={ownerToken:"x".repeat(43)};
  assert.throws(()=>parsePortableWorkspace(JSON.stringify(altered)),/supported portable/);
  const broken=JSON.parse(raw);broken.workspace.draft.fields=[{key:"price",value:12}];
  assert.throws(()=>parsePortableWorkspace(JSON.stringify(broken)),/unfinished edit/);
});


test("portable kept options retain their source binding after a new browser session",async()=>{
  const {WorkspaceController}=await import("../app/controller.mjs");
  const {ScenarioComparison}=await import("../app/scenario-comparison.mjs");
  const {creation,revision,at}=await import("./fixtures.mjs");
  const first=new WorkspaceController();first.replaceWithNew(creation());
  const options=new ScenarioComparison();const id=options.pin("Keep original",revision(),first.captureAction());
  first.approve(first.captureAction(),{eventId:"later-approval",at:at(10),memberId:"asha"});
  const raw=exportPortableWorkspace({project:first.exportText(),draft:null,scenarios:options.snapshot(first.captureAction())});
  const saved=parsePortableWorkspace(raw);const next=new WorkspaceController();
  next.adoptImport(next.beginImport(),next.parseImport(saved.project),true);
  const restored=new ScenarioComparison();restored.restore(saved.scenarios,next.captureAction());
  assert.equal(restored.list(next.captureAction())[0].stale,true);
  assert.throws(()=>restored.copy(id,next.captureAction()),/agreement changed/);
  assert.equal(next.exportText(),first.exportText());
});

test("saved sharing choices remain explicit and bound to unfinished members and purchases",()=>{
  const draft={creating:true,revision:{members:[{id:"a",name:"A"}],items:[{id:"i",label:"Tickets",weights:[]}]},
    base:{generation:1,session:1},fromOrdinal:null,title:"Trip",note:"Still deciding",goal:"",
    fields:[],sharingChoice:{method:"minimum_change",fixedItems:["i"],fixedPeople:["a"]}};
  const snapshot={project:null,draft};
  assert.deepEqual(parsePortableWorkspace(exportPortableWorkspace(snapshot)),snapshot);
  for(const change of [
    {method:"automatic"}, {fixedItems:["absent"]}, {fixedPeople:["other"]},
    {fixedItems:["i","i"]}, {candidate:{totalMinor:0}}, {method:null}
  ]) {
    const invalid=structuredClone(snapshot);Object.assign(invalid.draft.sharingChoice,change);
    assert.throws(()=>exportPortableWorkspace(invalid),/sharing choices/);
  }
  const incomplete=structuredClone(snapshot);incomplete.draft.sharingChoice.method="";
  assert.deepEqual(parsePortableWorkspace(exportPortableWorkspace(incomplete)),incomplete);
});
