import { evaluateRevision } from "../app/core.mjs";
import { proposeBudgetRescue } from "../app/budget-rescue.mjs";
import { validateSuggestion, SuggestionError } from "../app/ai-negotiation.mjs";

const methods=["balanced_extra","balanced_total","minimum_change","clarify"];
const object=value=>value!==null && typeof value==="object" && !Array.isArray(value);
export function policyRequest(goal) {
  return {schema:{type:"object",additionalProperties:false,required:["method"],properties:{method:{type:"string",enum:methods}}},prompt:{request:goal}};
}
export function preferenceRequest(revision,goal,method) {
  const roleMap=(rows,roles)=>({
    type:"object",additionalProperties:false,required:rows.map(row=>row.id),
    properties:Object.fromEntries(rows.map(row=>[row.id,{type:"object",additionalProperties:false,
      required:["role","quote"],properties:{role:{type:"string",enum:roles},quote:{type:"string",maxLength:1200}}}]))
  });
  return {
    schema:{type:"object",additionalProperties:false,required:["purchases","people"],properties:{
      purchases:roleMap(revision.items,["keep","unspecified"]),
      people:roleMap(revision.members,["reduce","help","keep","unspecified"])
    }},
    maxTokens:Math.min(2048,64+64*(revision.items.length+revision.members.length)),
    prompt:{request:goal,
      purchases:revision.items.map(item=>({id:item.id,name:item.label})),
      people:revision.members.map(member=>({id:member.id,name:member.name}))}
  };
}
const normalized=value=>value.toLowerCase().replace(/\s+/g," ").trim().replace(/[.!?;,:]+$/u,"");
const words=value=>(normalized(value).match(/[\p{L}\p{N}]+/gu)||[]).map(word=>word.length>3&&word.endsWith("s")?word.slice(0,-1):word);
export function preferenceFromRoles(revision,goal,method,roles) {
  if(!object(roles)||Object.keys(roles).length!==2||!roles.purchases||!roles.people)
    throw new SuggestionError("The model did not classify the purchases and people in this draft. Nothing changed.");
  const issues=[],sourceLinkedQuotes=[];
  const read=(map,rows,allowed,label)=>{
    if(!object(map)||Object.keys(map).length!==rows.length||rows.some(row=>!Object.hasOwn(map,row.id)))
      throw new SuggestionError("The model's "+label+" do not match this draft. Nothing changed.");
    for(const row of rows) {
      const value=map[row.id];
      if(!object(value)||Object.keys(value).length!==2||!allowed.includes(value.role)||typeof value.quote!=="string")
        throw new SuggestionError("The model returned an invalid role for "+(row.name||row.label)+". Nothing changed.");
      if(value.role==="unspecified")continue;
      let quote=normalized(value.quote);const name=row.name||row.label;
      const unique=words(name).filter(word=>!rows.some(other=>other.id!==row.id&&words(other.name||other.label).includes(word)));
      const mentions=text=>unique.some(word=>words(text).includes(word))||
        (label==="people"?/\b(everyone|everybody|all people)\b/:/\b(all purchases|all items)\b/).test(text);
      // The request already owns its words. A missing copied quote can be
      // linked to one unambiguous entity clause without changing the model role.
      // Keep the original empty model quote and record this derivation separately.
      if(!quote) {
        const clauses=goal.split(/(?<=[.!?;])(?:\s+|$)/u).map(text=>text.trim()).filter(text=>text&&mentions(normalized(text)));
        if(clauses.length===1) {
          quote=normalized(clauses[0]);
          sourceLinkedQuotes.push({kind:label,id:row.id,quote:clauses[0]});
        }
      }
      if(!quote||!normalized(goal).includes(quote)||!mentions(quote))
        issues.push("The model's "+value.role+" choice for "+name+" is not supported by a matching quoted instruction. Review that choice.");
    }
    return map;
  };
  const purchases=read(roles.purchases,revision.items,["keep","unspecified"],"purchases");
  const people=read(roles.people,revision.members,["reduce","help","keep","unspecified"],"people");
  const current=evaluateRevision(revision),hasHelpers=Object.values(people).some(value=>value.role==="help");
  const fixedPeople=current.members.filter(member=>people[member.id].role==="keep"||
    (hasHelpers&&member.overMinor===0&&people[member.id].role==="unspecified")).map(member=>member.id);
  return {preference:{method,fixedItems:revision.items.filter(item=>purchases[item.id].role==="keep").map(item=>item.id),fixedPeople},
    evidence:sourceLinkedQuotes.length?{...roles,sourceLinkedQuotes}:roles,error:issues[0]||null};
}

function validIds(values,source,label) {
  if (!Array.isArray(values) || new Set(values).size!==values.length ||
      values.some(id=>typeof id!=="string" || !source.some(row=>row.id===id)))
    throw new SuggestionError("The interpreted "+label+" do not match this draft. Nothing changed.");
  return values;
}
function possible(result) {
  return result.status==="suggestion" || result.status==="already-feasible";
}
function unavailable(result) {
  if (result.status==="unfunded")
    return "The recorded limits fall short by $"+(result.shortfallMinor/100).toFixed(2)+". A different split cannot fund this purchase.";
  return "Those unchanged shares and participation choices cannot fit the limits in this draft. Change the request or the draft; no substitute was chosen.";
}
export function preferenceForReview(revision,preference) {
  if (!object(preference) || Object.keys(preference).length!==3 ||
      !["method","fixedItems","fixedPeople"].every(key=>Object.hasOwn(preference,key)) ||
      !methods.includes(preference.method))
    throw new SuggestionError("The model did not return a supported preference. Nothing changed.");
  const fixedItemIds=validIds(preference.fixedItems,revision.items,"purchases");
  const fixedMemberIds=validIds(preference.fixedPeople,revision.members,"people");
  return {method:preference.method,fixedItems:[...fixedItemIds],fixedPeople:[...fixedMemberIds]};
}
export function counterofferFromPreference(revision,preference) {
  const checkedPreference=preferenceForReview(revision,preference);
  const fixedItemIds=checkedPreference.fixedItems, fixedMemberIds=checkedPreference.fixedPeople;
  if (preference.method==="clarify")
    throw new SuggestionError("The request needs a more specific tradeoff. Say whose shares or which purchases should stay unchanged, and whether to balance extra costs, balance total shares, or move the fewest item cents.");
  const before=evaluateRevision(revision);
  // An unchanged purchase is an exact lower bound, even if the model also
  // invented a protected person. Explain that unavoidable conflict first.
  for(const member of before.members) {
    const fixed=revision.items.flatMap((item,index)=>{
      if(!fixedItemIds.includes(item.id))return [];
      const minor=before.items[index].allocations.find(row=>row.memberId===member.id).minor;
      return minor>0?[{label:item.label,minor}]:[];
    });
    const minimum=fixed.reduce((sum,item)=>sum+item.minor,0);
    if(member.budgetMinor!==null && minimum>member.budgetMinor)
      throw new SuggestionError(member.name+" cannot fit the $"+(member.budgetMinor/100).toFixed(2)+" limit: unchanged "+fixed.map(item=>item.label).join(" and ")+" shares already total $"+(minimum/100).toFixed(2)+".");
  }
  for(const member of before.members) {
    if(fixedMemberIds.includes(member.id) && member.budgetMinor!==null && member.amountMinor>member.budgetMinor)
      throw new SuggestionError("Keeping "+member.name+"'s current shares unchanged cannot fit the $"+(member.budgetMinor/100).toFixed(2)+" limit: they total $"+(member.amountMinor/100).toFixed(2)+".");
  }
  const constraints={fixedItemIds,fixedMemberIds};
  const base=proposeBudgetRescue(revision,constraints);
  if (!possible(base)) throw new SuggestionError(unavailable(base));
  let result=base, cap=null, balancedPeople=[];
  if (preference.method!=="minimum_change") {
    const extra=preference.method==="balanced_extra";
    if (extra && base.status==="already-feasible")
      throw new SuggestionError("Every recorded limit is already met; there is no excess cost to share. Edit the relevant limit first, or ask to balance total shares.");
    balancedPeople=before.members.filter(member=>!fixedMemberIds.includes(member.id) && (!extra || member.overMinor===0));
    if (!balancedPeople.length) throw new SuggestionError("No remaining people can share that cost under these preferences.");
    const amount=extra ? before.members.reduce((sum,member)=>sum+member.overMinor,0)
      : before.totalMinor-before.members.filter(member=>fixedMemberIds.includes(member.id)).reduce((sum,member)=>sum+member.amountMinor,0);
    const floor=Math.floor(amount/balancedPeople.length), ceiling=Math.ceil(amount/balancedPeople.length);
    const memberCapsMinor=Object.fromEntries(balancedPeople.map(member=>[member.id,(extra?member.amountMinor:0)+ceiling]));
    const balanceFloorMinor=Object.fromEntries(balancedPeople.map(member=>[member.id,(extra?member.amountMinor:0)+floor]));
    result=proposeBudgetRescue(revision,{...constraints,memberCapsMinor,balanceFloorMinor});
    if (!possible(result)) throw new SuggestionError(unavailable(result));
    const final=result.after || before;
    const portions=balancedPeople.map(member=>final.members.find(row=>row.id===member.id).amountMinor-(extra?member.amountMinor:0));
    if (portions.some(portion=>portion<floor || portion>ceiling) || portions.reduce((sum,portion)=>sum+portion,0)!==amount)
      throw new SuggestionError("An equal split to the nearest cent cannot fit these unchanged shares, participation choices and recorded limits. No unequal substitute was chosen.");
    cap=ceiling;
  }
  if (result.status!=="suggestion")
    throw new SuggestionError("The current split already meets that preference. No different draft was produced.");
  const after=result.after;
  const changedItems=revision.items.flatMap((item,index)=>{
    const previous=before.items[index], next=after.items[index];
    const rows=previous.allocations.map(row=>{
      const amount=next.allocations.find(value=>value.memberId===row.memberId).minor;
      return {memberId:row.memberId,name:revision.members.find(member=>member.id===row.memberId).name,
        beforeMinor:row.minor,afterMinor:amount,deltaMinor:amount-row.minor};
    });
    return rows.some(row=>row.deltaMinor!==0)?[{itemId:item.id,label:item.label,rows}]:[];
  });
  if (!changedItems.length)
    throw new SuggestionError("The current split already meets that preference. No different draft was produced.");
  const fixedItems=revision.items.filter(item=>fixedItemIds.includes(item.id)).map(({id,label})=>({id,label}));
  const fixedPeople=revision.members.filter(member=>fixedMemberIds.includes(member.id)).map(({id,name})=>({id,name}));
  const criterion=preference.method==="balanced_extra"
    ? "Share the excess cost equally to the nearest cent among "+balancedPeople.map(member=>member.name).join(", ")+", then move the fewest item cents."
    : preference.method==="balanced_total"
      ? "Equalize total shares to the nearest cent among "+balancedPeople.map(member=>member.name).join(", ")+", then move the fewest item cents."
      : "Make the smallest changes needed to fit everyone’s limits.";
  const details=[criterion,
    fixedItems.length?"Keep "+fixedItems.map(item=>item.label).join(", ")+" unchanged.":"",
    fixedPeople.length?"Keep every item share for "+fixedPeople.map(member=>member.name).join(", ")+" unchanged.":""
  ].filter(Boolean).join(" ");
  const checked=validateSuggestion(revision,{
    itemWeights:result.revision.items.map(item=>{
      // Reduce exact-cent ratios when possible so copied drafts retain readable
      // relative weights; the production allocator still yields identical cents.
      if (!changedItems.some(row=>row.itemId===item.id)) return {itemId:item.id,weights:revision.items.find(row=>row.id===item.id).weights};
      const gcd=(a,b)=>{while(b){const next=a%b;a=b;b=next;}return a;};
      const divisor=item.weights.reduce((value,weight)=>gcd(value,weight.units),0) || 1;
      return {itemId:item.id,weights:item.weights.map(weight=>({memberId:weight.memberId,units:weight.units/divisor}))};
    }),
    explanation:details
  });
  return {...checked,interpretation:{method:preference.method,fixedItems,fixedPeople,capMinor:cap},
    itemChanges:changedItems,
    disclosure:"Suggested draft only. Check the interpreted preference and every amount. No revision, agreement or payment was recorded."};
}

