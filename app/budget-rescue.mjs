// Suggestions preserve authored participation: zero weight means excluded.
// No event, consent declaration, or payment is written here.
import { allocateItem, evaluateRevision } from "./core.mjs";
const ascii = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function constraintsFor(revision, options) {
  const fixedItems = new Set(options.fixedItemIds || []);
  const fixedPeople = new Set(options.fixedMemberIds || []);
  for (const id of fixedItems) if (!revision.items.some(item => item.id === id))
    throw new Error("A fixed purchase is not in the current draft.");
  for (const id of fixedPeople) if (!revision.members.some(member => member.id === id))
    throw new Error("A fixed person is not in the current draft.");
  return { ...options, fixedItems, fixedPeople };
}
function spendingCap(member, before, constraints) {
  let cap = Math.min(member.budgetMinor, before.totalMinor);
  if (constraints.memberCapsMinor?.[member.id] !== undefined)
    cap = Math.min(cap,constraints.memberCapsMinor[member.id]);
  return cap;
}

// Integral min-cost flow. Retaining an existing item allocation costs zero;
// assigning a cent beyond it costs one. Frozen cells are removed before flow,
// then restored exactly. Residual reverse edges allow indirect exchanges.
// Optional sink priority minimizes cents above equal-share floors before item
// movement. Integer cost pairs keep that ordering exact without large multipliers.
function splitWithinParticipation(revision, before, constraints) {
  const members = [...revision.members].sort((a,b) => ascii(a.id,b.id));
  const items = [...revision.items].sort((a,b) => ascii(a.id,b.id));
  const source = 0, firstItem = 1, firstMember = 1 + items.length;
  const sink = firstMember + members.length;
  const graph = Array.from({length:sink+1}, () => []);
  const add = (from,to,capacity,cost,priority=0) => {
    const edge = {to,capacity,cost,priority,reverse:graph[to].length,initial:capacity};
    graph[from].push(edge);
    graph[to].push({to:from,capacity:0,cost:-cost,priority:-priority,reverse:graph[from].length-1,initial:0});
    return edge;
  };
  const memberNode = new Map(members.map((member,index) => [member.id,firstMember+index]));
  const fixedByMember = new Map(members.map(member => [member.id,0]));
  const fixed = new Map(), remainingByItem = new Map(), oldByItem = new Map();
  let remainingTotal = 0;
  for (const item of items) {
    const old = new Map(allocateItem(item).map(allocation => [allocation.memberId,allocation.minor]));
    const row = new Map();
    let remaining = item.unitMinor * item.quantity;
    for (const member of members) {
      const amount = constraints.fixedItems.has(item.id) || constraints.fixedPeople.has(member.id)
        ? old.get(member.id) : 0;
      row.set(member.id,amount);
      fixedByMember.set(member.id,fixedByMember.get(member.id)+amount);
      remaining -= amount;
    }
    fixed.set(item.id,row); oldByItem.set(item.id,old);
    remainingByItem.set(item.id,remaining); remainingTotal += remaining;
  }
  const capacities = new Map(members.map(member =>
    [member.id,spendingCap(member,before,constraints)-fixedByMember.get(member.id)]));
  const constrained = constraints.fixedItems.size || constraints.fixedPeople.size ||
    constraints.memberCapsMinor !== undefined;
  if ([...capacities.values()].some(capacity => capacity < 0))
    return {status:"constraints-blocked",reason:"A share kept unchanged exceeds the allowed amount."};
  const cells = new Map();
  items.forEach((item,index) => {
    const remaining = remainingByItem.get(item.id), old = oldByItem.get(item.id);
    add(source,firstItem+index,remaining,0);
    const row = new Map();
    for (const weight of [...item.weights].sort((a,b) => ascii(a.memberId,b.memberId))) {
      if (weight.units === 0 || constraints.fixedItems.has(item.id) ||
          constraints.fixedPeople.has(weight.memberId)) continue;
      row.set(weight.memberId,[
        add(firstItem+index,memberNode.get(weight.memberId),old.get(weight.memberId),0),
        add(firstItem+index,memberNode.get(weight.memberId),remaining-old.get(weight.memberId),1)
      ]);
    }
    cells.set(item.id,row);
  });
  members.forEach((member,index) => {
    const capacity=capacities.get(member.id), floor=constraints.balanceFloorMinor?.[member.id];
    if (floor === undefined) { add(firstMember+index,sink,capacity,0); return; }
    const below=Math.max(0,Math.min(capacity,floor-fixedByMember.get(member.id)));
    add(firstMember+index,sink,below,0);
    add(firstMember+index,sink,capacity-below,0,1);
  });
  let flow = 0;
  while (flow < remainingTotal) {
    const distance = Array(graph.length).fill(Infinity), priorityDistance = Array(graph.length).fill(Infinity), parent = Array(graph.length);
    const queued = Array(graph.length).fill(false), queue = [source];
    distance[source]=0; priorityDistance[source]=0; queued[source]=true;
    for (let head=0;head<queue.length;head++) {
      const from=queue[head]; queued[from]=false;
      for (let index=0;index<graph[from].length;index++) {
        const edge=graph[from][index];
        const priority=priorityDistance[from]+edge.priority, cost=distance[from]+edge.cost;
        if (edge.capacity>0 && (priority<priorityDistance[edge.to] ||
            (priority===priorityDistance[edge.to] && cost<distance[edge.to]))) {
          priorityDistance[edge.to]=priority; distance[edge.to]=cost; parent[edge.to]=[from,index];
          if (!queued[edge.to]) {queue.push(edge.to);queued[edge.to]=true;}
        }
      }
    }
    if (!Number.isFinite(distance[sink])) {
      const blockedItems=items.filter((_,index) => Number.isFinite(distance[firstItem+index]));
      const blockedMembers=members.filter((_,index) => Number.isFinite(distance[firstMember+index]));
      const requiredMinor=blockedItems.reduce((sum,item) => sum+remainingByItem.get(item.id),0);
      const available=blockedMembers.reduce((sum,member) => sum+BigInt(capacities.get(member.id)),0n);
      return {status:constrained?"constraints-blocked":"participation-blocked",
        shortfallMinor:Number(BigInt(requiredMinor)-available),requiredMinor,availableMinor:Number(available),
        itemIds:blockedItems.map(item=>item.id),memberIds:blockedMembers.map(member=>member.id)};
    }
    let amount=remainingTotal-flow;
    for (let node=sink;node!==source;) {
      const [from,index]=parent[node]; amount=Math.min(amount,graph[from][index].capacity); node=from;
    }
    for (let node=sink;node!==source;) {
      const [from,index]=parent[node], edge=graph[from][index];
      edge.capacity-=amount; graph[node][edge.reverse].capacity+=amount; node=from;
    }
    flow+=amount;
  }
  return {status:"allocated",allocations:new Map(items.map(item => [item.id,new Map(
    item.weights.map(weight => [weight.memberId,fixed.get(item.id).get(weight.memberId) +
      (cells.get(item.id).get(weight.memberId)||[]).reduce((sum,edge) => sum+edge.initial-edge.capacity,0)])
  )]))};
}

/** Exact cents, unchanged purchases and exclusions; minimizes total item cents
 * reassigned among eligible members. Optional constraints retain authored cells
 * or impose per-person caps and an equal-share objective. No fairness or agreement claim. */
export function proposeBudgetRescue(revision, options = {}) {
  const before=evaluateRevision(revision), constraints=constraintsFor(revision,options);
  if (!before.budgetsKnown) return Object.freeze({ status: "unknown-limits", before });
  if (before.feasible && before.members.every(member =>
      member.amountMinor<=spendingCap(member,before,constraints) &&
      (constraints.balanceFloorMinor?.[member.id] === undefined ||
       member.amountMinor>=constraints.balanceFloorMinor[member.id])))
    return Object.freeze({status:"already-feasible",movedMinor:0,before});
  const sumLimits=revision.members.reduce((sum,member) => sum+BigInt(member.budgetMinor),0n);
  if (sumLimits<BigInt(before.totalMinor))
    return Object.freeze({status:"unfunded",shortfallMinor:Number(BigInt(before.totalMinor)-sumLimits),before});
  const result=splitWithinParticipation(revision,before,constraints);
  if (result.status!=="allocated") return Object.freeze({...result,before});
  const transfers=[];
  for (const item of revision.items) {
    const old=allocateItem(item), assigned=result.allocations.get(item.id);
    const donors=old.map(a=>({id:a.memberId,minor:a.minor-assigned.get(a.memberId)})).filter(a=>a.minor>0);
    const receivers=old.map(a=>({id:a.memberId,minor:assigned.get(a.memberId)-a.minor})).filter(a=>a.minor>0);
    for (const donor of donors) for (const receiver of receivers) {
      const minor=Math.min(donor.minor,receiver.minor);
      if (minor>0) {
        transfers.push(Object.freeze({itemId:item.id,fromMemberId:donor.id,toMemberId:receiver.id,minor}));
        donor.minor-=minor; receiver.minor-=minor;
      }
    }
  }
  const candidate={...revision,items:revision.items.map(item=>({...item,
    weights:item.weights.map(weight=>({
      memberId:weight.memberId,
      units:item.unitMinor===0 || constraints.fixedItems.has(item.id)
        ? weight.units : result.allocations.get(item.id).get(weight.memberId)
    }))
  }))};
  const after=evaluateRevision(candidate), movedMinor=transfers.reduce((sum,transfer)=>sum+transfer.minor,0);
  if (!after.feasible || after.totalMinor!==before.totalMinor || !Number.isSafeInteger(movedMinor))
    throw new Error("Budget rescue invariant failed: alternative did not conserve cents and satisfy limits");
  return Object.freeze({status:"suggestion",revision:candidate,before,after,movedMinor,transfers:Object.freeze(transfers)});
}
