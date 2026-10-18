const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");

initializeApp();
const db = getFirestore();
const REGION = "asia-southeast1";
const IDR = n => Number.isSafeInteger(n) && n > 0;
const validPeriod = p => typeof p === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
function requireEditor(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login diperlukan.");
  if (request.auth.token.role !== "editor") throw new HttpsError("permission-denied", "Hanya bendahara yang boleh melakukan perubahan.");
  return request.auth.uid;
}
function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpsError("invalid-argument", "Tanggal tidak valid.");
  const date = new Date(`${value}T00:00:00+07:00`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new HttpsError("invalid-argument", "Tanggal tidak valid.");
  return Timestamp.fromDate(date);
}
async function ensureOpenPeriod(period) {
  const ref = db.doc(`periods/${period}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== "open") throw new HttpsError("failed-precondition", "Periode tidak ditemukan atau sudah ditutup.");
  return { ref, data: snap.data() };
}
async function publishPayment(paymentId, data) {
  await db.doc(`publicPayments/${paymentId}`).set({
    studentId: data.studentId, period: data.period, amount: data.amount,
    status: data.status, paidAt: data.paidAt || null
  });
}
async function publishTransaction(transactionId, data) {
  await db.doc(`publicTransactions/${transactionId}`).set({
    type: data.type, amount: data.amount, description: data.description,
    period: data.period, createdAt: data.createdAt
  });
}
async function recomputeReport(period) {
  const periodSnap = await db.doc(`periods/${period}`).get();
  if (!periodSnap.exists) return;
  const periodData = periodSnap.data();
  const txSnap = await db.collection("transactions").where("period","==",period).get();
  let incomeTotal=0, expenseTotal=0;
  txSnap.forEach(d => {
    const t=d.data();
    if (t.type==="income") incomeTotal+=t.amount;
    if (t.type==="expense") expenseTotal+=t.amount;
  });
  const report = {
    period, openingBalance: Number(periodData.openingBalance||0),
    incomeTotal, expenseTotal,
    closingBalance: Number(periodData.openingBalance||0)+incomeTotal-expenseTotal,
    status: periodData.status, updatedAt: FieldValue.serverTimestamp()
  };
  await db.doc(`monthlyReports/${period}`).set(report,{merge:true});
  await db.doc(`publicReports/${period}`).set({
    period, openingBalance: report.openingBalance, incomeTotal, expenseTotal,
    closingBalance: report.closingBalance, status: report.status
  });
  await db.doc(`publicPeriods/${period}`).set({status:periodData.status});
}
exports.recordPayment = onCall({region:REGION, enforceAppCheck:false}, async request => {
  const uid=requireEditor(request);
  const {studentId,period,amount,paidAt}=request.data||{};
  if (typeof studentId!=="string" || !studentId || !validPeriod(period) || !IDR(amount)) throw new HttpsError("invalid-argument","Data pembayaran tidak valid.");
  const date=parseDate(paidAt);
  const studentRef=db.doc(`students/${studentId}`);
  const periodInfo=await ensureOpenPeriod(period);
  const studentSnap=await studentRef.get();
  if (!studentSnap.exists || studentSnap.data().active!==true) throw new HttpsError("not-found","Siswa tidak ditemukan atau tidak aktif.");
  const paymentId=`${period}_${studentId}`;
  const paymentRef=db.doc(`payments/${paymentId}`);
  const txRef=db.collection("transactions").doc();
  const auditRef=db.collection("auditLogs").doc();
  const result=await db.runTransaction(async t=>{
    const [paymentSnap,periodSnap]=await Promise.all([t.get(paymentRef),t.get(periodInfo.ref)]);
    if (!periodSnap.exists || periodSnap.data().status!=="open") throw new HttpsError("failed-precondition","Periode sudah ditutup.");
    if (paymentSnap.exists && paymentSnap.data().status==="paid") throw new HttpsError("already-exists","Pembayaran siswa ini sudah tercatat.");
    const payment={
      studentId,period,amount,status:"paid",paidAt:date,
      createdBy:uid,updatedAt:FieldValue.serverTimestamp()
    };
    const tx={
      type:"income",amount,period,description:`Kas ${studentSnap.data().name}`,
      studentId,createdBy:uid,createdAt:FieldValue.serverTimestamp(),source:"payment"
    };
    t.set(paymentRef,payment);
    t.set(txRef,tx);
    t.set(auditRef,{action:"recordPayment",target:paymentId,actor:uid,createdAt:FieldValue.serverTimestamp()});
    return {payment,tx};
  });
  await publishPayment(paymentId,result.payment);
  await publishTransaction(txRef.id,result.tx);
  await recomputeReport(period);
  return {ok:true,paymentId,transactionId:txRef.id};
});
exports.recordTransaction = onCall({region:REGION, enforceAppCheck:false}, async request=>{
  const uid=requireEditor(request);
  const {type,amount,description,period}=request.data||{};
  if (!["income","expense"].includes(type) || !IDR(amount) || typeof description!=="string" || !description.trim() || description.length>160 || !validPeriod(period)) throw new HttpsError("invalid-argument","Data transaksi tidak valid.");
  await ensureOpenPeriod(period);
  const ref=db.collection("transactions").doc(), audit=db.collection("auditLogs").doc();
  const data={type,amount,description:description.trim(),period,createdBy:uid,createdAt:FieldValue.serverTimestamp(),source:"manual"};
  await db.runTransaction(async t=>{
    const p=await t.get(db.doc(`periods/${period}`));
    if(!p.exists||p.data().status!=="open") throw new HttpsError("failed-precondition","Periode tidak terbuka.");
    t.create(ref,data);
    t.create(audit,{action:"recordTransaction",target:ref.id,actor:uid,createdAt:FieldValue.serverTimestamp()});
  });
  await publishTransaction(ref.id,data);
  await recomputeReport(period);
  return {ok:true,transactionId:ref.id};
});
exports.openNewMonth = onSchedule({schedule:"0 0 1 * *",timeZone:"Asia/Jakarta",region:REGION}, async ()=>{
  const now=new Date();
  const currentPeriod=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Jakarta",year:"numeric",month:"2-digit"}).format(now);
  const [year,month]=currentPeriod.split("-").map(Number);
  const prevDate=new Date(Date.UTC(year,month-2,1));
  const previousPeriod=`${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth()+1).padStart(2,"0")}`;
  const newRef=db.doc(`periods/${currentPeriod}`);
  const exists=await newRef.get();
  if(exists.exists) return;
  const prevRef=db.doc(`periods/${previousPeriod}`);
  const prevSnap=await prevRef.get();
  let openingBalance=0;
  if(prevSnap.exists){
    const txs=await db.collection("transactions").where("period","==",previousPeriod).get();
    let income=0,expense=0;
    txs.forEach(d=>{const x=d.data(); if(x.type==="income")income+=x.amount;else if(x.type==="expense")expense+=x.amount;});
    openingBalance=Number(prevSnap.data().openingBalance||0)+income-expense;
    await db.runTransaction(async t=>{
      const fresh=await t.get(prevRef);
      if(fresh.exists && fresh.data().status==="open") t.update(prevRef,{status:"closed",closedAt:FieldValue.serverTimestamp()});
    });
    const closedReport={period:previousPeriod,openingBalance:Number(prevSnap.data().openingBalance||0),incomeTotal:income,expenseTotal:expense,closingBalance:openingBalance,status:"closed",closedAt:FieldValue.serverTimestamp()};
    await db.doc(`monthlyReports/${previousPeriod}`).set(closedReport,{merge:true});
    await db.doc(`publicReports/${previousPeriod}`).set({period:previousPeriod,openingBalance:closedReport.openingBalance,incomeTotal:income,expenseTotal:expense,closingBalance,status:"closed"});
    await db.doc(`publicPeriods/${previousPeriod}`).set({status:"closed"});
  }
  // Use the fee configured by the class admin. Default to 10,000 only for this starter template.
  const settingsSnap=await db.doc("settings/class").get();
  const feeAmount=Number(settingsSnap.exists?settingsSnap.data().feeAmount:10000);
  await newRef.create({feeAmount,openingBalance,status:"open",createdAt:FieldValue.serverTimestamp()});
  await db.doc(`publicPeriods/${currentPeriod}`).set({status:"open"});
  const students=await db.collection("students").where("active","==",true).get();
  const batch=db.batch();
  students.forEach(s=>{
    const paymentId=`${currentPeriod}_${s.id}`;
    batch.set(db.doc(`payments/${paymentId}`),{studentId:s.id,period:currentPeriod,amount:feeAmount,status:"unpaid",paidAt:null,createdBy:"system",updatedAt:FieldValue.serverTimestamp()});
    batch.set(db.doc(`publicPayments/${paymentId}`),{studentId:s.id,period:currentPeriod,amount:feeAmount,status:"unpaid",paidAt:null});
    batch.set(db.doc(`publicStudents/${s.id}`),{name:s.data().name,active:s.data().active,feeAmount});
  });
  await batch.commit();
  await recomputeReport(currentPeriod);
});
exports.publishStudent = onCall({region:REGION, enforceAppCheck:false}, async request=>{
  requireEditor(request);
  const {name,studentId}=request.data||{};
  if(typeof name!=="string"||name.trim().length<2||name.trim().length>80||typeof studentId!=="string"||!/^[A-Za-z0-9_-]{1,80}$/.test(studentId)) throw new HttpsError("invalid-argument","Nama atau ID siswa tidak valid.");
  const ref=db.doc(`students/${studentId}`);
  const data={name:name.trim(),active:true,updatedAt:FieldValue.serverTimestamp(),updatedBy:request.auth.uid};
  await ref.set(data,{merge:true});
  await db.doc(`publicStudents/${studentId}`).set({name:data.name,active:true});
  await db.collection("auditLogs").add({action:"publishStudent",target:studentId,actor:request.auth.uid,createdAt:FieldValue.serverTimestamp()});
  return {ok:true,studentId};
});
