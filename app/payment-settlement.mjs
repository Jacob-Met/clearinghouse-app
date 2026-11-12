// Exact, read-only funding consequences of the current recorded plan.
// Callers supply source-bound provider observations, never browser payment claims.
const integer = value => Number.isSafeInteger(value) && value >= 0;
const add = (a,b) => {
  const value=a+b;
  if(!integer(value))throw new Error("Payment totals exceed exact supported cents.");
  return value;
};
const cents = value => {
  if(typeof value!=="string" || !/^\d+\.\d{2}$/.test(value))throw new Error("Invalid observed USD amount.");
  const amount=Number(value.replace(".",""));
  if(!integer(amount))throw new Error("Invalid observed USD amount.");
  return amount;
};

export function retainedPayment(order) {
  const amountMinor=cents(order.amount);
  const uncertain=reason=>({known:false,amountMinor,reason});
  if(order.status==="UNKNOWN")return uncertain("Payment status is unavailable.");
  if(order.captureStatus==="PENDING")return uncertain("A payment is still pending.");
  if(order.refundUncertain)return uncertain("A refund is pending or unverified.");
  if(order.captureStatus==="REFUNDED" && order.captureId)return {known:true,amountMinor,heldMinor:0,refundedMinor:amountMinor};
  if(order.captureStatus==="COMPLETED" && order.captured===true && order.captureId){
    if((order.refunds||[]).some(r=>r.status==="PENDING"))return uncertain("A refund is pending.");
    if((order.refunds||[]).some(r=>r.status==="COMPLETED"))return uncertain("Capture and refund observations disagree.");
    return {known:true,amountMinor,heldMinor:amountMinor,refundedMinor:0};
  }
  if(order.captureStatus==="PARTIALLY_REFUNDED"){
    if(!order.captureId || !order.refundsKnown || !Array.isArray(order.refunds))return uncertain("The remaining captured amount is unavailable.");
    if(order.refunds.some(r=>r.status==="PENDING"))return uncertain("A refund is pending.");
    const seen=new Set();let returned=0;
    for(const refund of order.refunds){
      if(!refund.id || seen.has(refund.id) || !integer(refund.amountMinor) || refund.amountMinor===0)return uncertain("Refund records disagree.");
      seen.add(refund.id);
      const up=Array.isArray(refund.links)?refund.links.filter(link=>link.rel==="up"):[];
      let source;
      try{source=new URL(up[0]?.href);}catch{return uncertain("Refund capture identity is unavailable.");}
      if(up.length!==1||source.protocol!=="https:"||!["api-m.sandbox.paypal.com","api.sandbox.paypal.com"].includes(source.hostname)||
        source.port||source.username||source.password||source.search||source.hash||source.pathname!=="/v2/payments/captures/"+order.captureId)
        return uncertain("Refund belongs to a different capture.");
      if(!["COMPLETED","FAILED","CANCELLED"].includes(refund.status))return uncertain("Refund status is unavailable.");
      if(refund.status==="COMPLETED")returned=add(returned,refund.amountMinor);
    }
    if(returned<=0 || returned>=amountMinor)return uncertain("Refund totals disagree with the partial capture.");
    return {known:true,amountMinor,heldMinor:amountMinor-returned,refundedMinor:returned};
  }
  if(order.status==="COMPLETED")return uncertain("The completed order has no verified final capture.");
  if(!["CREATED","SAVED","PAYER_ACTION_REQUIRED","APPROVED","VOIDED","NOT_PREPARED","NO_OBLIGATION"].includes(order.status))
    return uncertain("Payment status is unavailable.");
  return {known:true,amountMinor,heldMinor:0,refundedMinor:0};
}

export function paymentSettlement(state, orders) {
  if(!state?.current || !Array.isArray(orders))throw new Error("A recorded plan and payment observations are required.");
  const knownMembers=new Map();
  for(const revision of state.revisions)for(const member of revision.members)knownMembers.set(member.id,member.name);
  const current=new Map(state.evaluation.members.map(member=>[member.id,member]));
  const rows=new Map([...current].map(([id,member])=>[id,{memberId:id,memberName:member.name,current:true,
    obligationMinor:member.amountMinor,knownHeldMinor:0,knownRefundedMinor:0,orders:[],uncertain:[]}]));
  const identities=new Map(),captureIds=new Map();
  for(const order of orders){
    if(!knownMembers.has(order.memberId) || !order.orderId)throw new Error("Payment is outside this plan's recorded participants.");
    const signature=JSON.stringify(order);
    if(identities.has(order.orderId)){
      if(identities.get(order.orderId)!==signature)throw new Error("Repeated order observations disagree.");
      continue;
    }
    identities.set(order.orderId,signature);
    if(order.captureId){
      if(captureIds.has(order.captureId)&&captureIds.get(order.captureId)!==order.orderId)throw new Error("A capture belongs to conflicting orders.");
      captureIds.set(order.captureId,order.orderId);
    }
    if(!rows.has(order.memberId))rows.set(order.memberId,{memberId:order.memberId,memberName:knownMembers.get(order.memberId),
      current:false,obligationMinor:0,knownHeldMinor:0,knownRefundedMinor:0,orders:[],uncertain:[]});
    const row=rows.get(order.memberId),money=retainedPayment(order);
    row.orders.push({orderId:order.orderId,captureId:order.captureId||null,revisionId:order.revisionId,...money});
    if(money.known){
      row.knownHeldMinor=add(row.knownHeldMinor,money.heldMinor);
      row.knownRefundedMinor=add(row.knownRefundedMinor,money.refundedMinor);
    }else row.uncertain.push({orderId:order.orderId,reason:money.reason});
  }
  const members=[...rows.values()].map(row=>{
    const known=row.uncertain.length===0;
    return {...row,known,heldMinor:known?row.knownHeldMinor:null,
      creditMinor:known?Math.min(row.obligationMinor,row.knownHeldMinor):null,
      topUpMinor:known?Math.max(0,row.obligationMinor-row.knownHeldMinor):null,
      refundDueMinor:known?Math.max(0,row.knownHeldMinor-row.obligationMinor):null};
  });
  const sum=key=>members.reduce((total,row)=>add(total,row[key]),0);
  const known=members.every(row=>row.known);
  return {projectId:state.project.projectId,revisionId:state.current.revisionId,ordinal:state.current.ordinal,
    agreementRecorded:state.evaluation.agreementRecorded,known,members,
    obligationMinor:sum("obligationMinor"),knownHeldMinor:sum("knownHeldMinor"),
    heldMinor:known?sum("heldMinor"):null,creditMinor:known?sum("creditMinor"):null,
    topUpMinor:known?sum("topUpMinor"):null,refundDueMinor:known?sum("refundDueMinor"):null,
    settled:known&&state.evaluation.agreementRecorded&&members.every(row=>row.topUpMinor===0&&row.refundDueMinor===0)};
}
