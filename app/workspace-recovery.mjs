import { importProject } from "./core.mjs";
import { validateSavedScenarios } from "./scenario-comparison.mjs";
export const RECOVERY_PREFIX = "clearinghouse.workspace.v1.";
const FORMAT = "clearinghouse-browser-workspace";

export function parseSavedWorkspace(raw) {
  const record = JSON.parse(raw);
  if (!record || record.format !== FORMAT || record.version !== 1 ||
      typeof record.stamp !== "string" || typeof record.savedAt !== "string" ||
      !record.workspace || typeof record.workspace !== "object")
    throw new Error("This browser copy uses an unsupported recovery format.");
  const {project, draft, sharedOrganizer} = record.workspace;
  if (project !== null && typeof project !== "string")
    throw new Error("The saved plan history could not be read.");
  if (draft !== null && (!draft || typeof draft !== "object" ||
      typeof draft.creating !== "boolean" || !draft.revision ||
      !Array.isArray(draft.revision.members) || !Array.isArray(draft.revision.items) ||
      !Array.isArray(draft.fields)))
    throw new Error("The saved unfinished edit could not be read.");
  if (draft?.sharingChoice !== undefined) {
    const choice=draft.sharingChoice;
    const ids=(values,rows)=>Array.isArray(values) && values.every(id=>typeof id==="string" && rows.some(row=>row?.id===id)) && new Set(values).size===values.length;
    if(!choice || typeof choice!=="object" || Array.isArray(choice) ||
       Object.keys(choice).some(key=>!["method","fixedItems","fixedPeople"].includes(key)) ||
       !["","balanced_extra","balanced_total","minimum_change"].includes(choice.method) ||
       !ids(choice.fixedItems,draft.revision.items) || !ids(choice.fixedPeople,draft.revision.members))
      throw new Error("The saved sharing choices do not match this unfinished edit.");
  }
  if (sharedOrganizer !== undefined && (!sharedOrganizer ||
      typeof sharedOrganizer.projectId !== "string" ||
      typeof sharedOrganizer.ownerToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(sharedOrganizer.ownerToken) ||
      !project || JSON.parse(project).projectId !== sharedOrganizer.projectId))
    throw new Error("The saved organizer access does not match this plan.");
  if (record.workspace.scenarios !== undefined)
    validateSavedScenarios(record.workspace.scenarios, project ? JSON.parse(project).projectId : null);
  if (!project && !draft) throw new Error("The saved copy contains no work.");
  return record;
}

// A held browser Web Lock makes every subsequent localStorage write synchronous.
// A closing tab therefore cannot strand the last keystroke in an async save queue.
// Another tab may read this copy, but must make its own copy before writing it.
export class BrowserWorkspaceStore {
  constructor(storage, locks, makeId = () => crypto.randomUUID(), clock = () => new Date().toISOString()) {
    this.storage = storage; this.locks = locks; this.makeId = makeId; this.clock = clock;
    this.key = null; this.stamp = null; this.releaseHeldLock = null;
  }
  list() {
    const result = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(RECOVERY_PREFIX)) continue;
      try { result.push({key, record: parseSavedWorkspace(this.storage.getItem(key))}); }
      catch (error) { result.push({key, error: error.message}); }
    }
    return result.sort((a,b) => (b.record?.savedAt ?? "").localeCompare(a.record?.savedAt ?? ""));
  }
  read(key) {
    if (!key.startsWith(RECOVERY_PREFIX)) throw new Error("Not a browser workspace key.");
    const raw = this.storage.getItem(key);
    return raw === null ? null : parseSavedWorkspace(raw);
  }
  async claim(key = RECOVERY_PREFIX + this.makeId()) {
    this.release();
    if (!this.locks?.request) throw new Error("This browser cannot protect saved work across tabs.");
    return new Promise((resolve,reject) => {
      this.locks.request(key, {ifAvailable:true}, lock => {
        if (!lock) { resolve({acquired:false, key}); return; }
        let record;
        try { record = this.read(key); }
        catch (error) { reject(error); return; }
        this.key = key; this.stamp = record?.stamp ?? null;
        return new Promise(release => {
          this.releaseHeldLock = release;
          resolve({acquired:true, key, record});
        });
      }).catch(reject);
    });
  }
  save(workspace) {
    if (!this.key || !this.releaseHeldLock) throw new Error("This tab is not saving a browser copy.");
    const existing = this.read(this.key);
    if ((existing?.stamp ?? null) !== this.stamp)
      throw new Error("This saved copy changed outside this tab. Your current work is still here.");
    const record = {format:FORMAT, version:1, stamp:this.makeId(), savedAt:this.clock(), workspace};
    const raw = JSON.stringify(record);
    parseSavedWorkspace(raw);
    this.storage.setItem(this.key, raw);
    this.stamp = record.stamp;
    return record;
  }
  remove() {
    if (!this.key || !this.releaseHeldLock) throw new Error("Open this browser copy before removing it.");
    const existing = this.read(this.key);
    if ((existing?.stamp ?? null) !== this.stamp) throw new Error("The saved copy changed. Open it again before removing it.");
    this.storage.removeItem(this.key);
    this.release();
  }
  release() {
    this.releaseHeldLock?.();
    this.releaseHeldLock = null; this.key = null; this.stamp = null;
  }
}


// A portable copy carries authored work, never access to a hosted group.
export function exportPortableWorkspace(snapshot) {
  const workspace = {
    project: snapshot.project, draft: snapshot.draft,
    ...(snapshot.scenarios !== undefined ? {scenarios:snapshot.scenarios} : {})
  };
  const raw = JSON.stringify({format:"clearinghouse-portable-workspace",version:1,workspace});
  parsePortableWorkspace(raw);
  return raw;
}

export function parsePortableWorkspace(raw) {
  const portable = JSON.parse(raw);
  if (!portable || portable.format !== "clearinghouse-portable-workspace" || portable.version !== 1 ||
      !portable.workspace || Object.keys(portable.workspace).some(key => !["project","draft","scenarios"].includes(key)))
    throw new Error("This file is not a supported portable workspace.");
  const workspace = parseSavedWorkspace(JSON.stringify({
    format:FORMAT,version:1,stamp:"portable",savedAt:"portable",workspace:portable.workspace
  })).workspace;
  if (workspace.project) importProject(workspace.project);
  const d = workspace.draft;
  if (d) {
    if ((!d.creating && !workspace.project) || !d.base || typeof d.base !== "object" ||
        !["title","note","goal"].every(key => typeof d[key] === "string") ||
        !(d.fromOrdinal === null || Number.isSafeInteger(d.fromOrdinal)) ||
        !d.revision.members.length || !d.revision.items.length ||
        d.revision.members.some(m => !m || typeof m.id !== "string" || typeof m.name !== "string") ||
        d.revision.items.some(i => !i || typeof i.id !== "string" || typeof i.label !== "string" || !Array.isArray(i.weights)) ||
        d.fields.some(f => !f || typeof f.key !== "string" || typeof f.value !== "string" ||
          ("checked" in f && typeof f.checked !== "boolean")))
      throw new Error("This portable unfinished edit could not be read.");
  }
  return workspace;
}
