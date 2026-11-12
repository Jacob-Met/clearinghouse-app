import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createParticipation} from "../server/participation.mjs";

test("organizer sessions persist in the existing journal, expire, sign out and rotate",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-session-")),storagePath=join(dir,"participation.json");
  const organizerCode=randomBytes(32).toString("base64url");let clock=1000;
  try{
    let store=createParticipation({storagePath,organizerCode,now:()=>clock});
    await assert.rejects(store.organizerLogin("wrong"),e=>e.status===401);
    const first=await store.organizerLogin(organizerCode);
    const disk=await readFile(storagePath,"utf8");
    assert.ok(!disk.includes(organizerCode));assert.ok(!disk.includes(first.session));
    store=createParticipation({storagePath,organizerCode,now:()=>clock});
    await store.organizerRead(first.session);
    clock+=8*60*60*1000;await assert.rejects(store.organizerRead(first.session),e=>e.status===401);
    const second=await store.organizerLogin(organizerCode);await store.organizerLogout(second.session);
    await assert.rejects(store.organizerRead(second.session),e=>e.status===401);
    const third=await store.organizerLogin(organizerCode);
    store=createParticipation({storagePath,organizerCode:randomBytes(32).toString("base64url"),now:()=>clock});
    await assert.rejects(store.organizerRead(third.session),e=>e.status===401);
    await assert.rejects(store.organizerLogin(organizerCode),e=>e.status===401);
  }finally{await rm(dir,{recursive:true,force:true});}
});
