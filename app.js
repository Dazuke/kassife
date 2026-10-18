import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, orderBy, limit
} from "https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-functions.js";

/*
 * LANGKAH WAJIB:
 * 1. Buat project Firebase.
 * 2. Tambahkan Web App di Project settings.
 * 3. Ganti nilai di bawah dengan konfigurasi project milikmu.
 * Jangan menaruh service-account key atau private key di file frontend.
 */
const firebaseConfig = {
  apiKey: "GANTI_DENGAN_API_KEY",
  authDomain: "GANTI_PROJECT_ID.firebaseapp.com",
  projectId: "GANTI_PROJECT_ID",
  storageBucket: "GANTI_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "GANTI_MESSAGING_SENDER_ID",
  appId: "GANTI_APP_ID"
};

const configured = !Object.values(firebaseConfig).some(v => String(v).startsWith("GANTI_"));
const $ = id => document.getElementById(id);
const rupiah = value => new Intl.NumberFormat("id-ID", {style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(value||0));
const monthNow = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
};
const prettyMonth = key => {
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return "Periode —";
  const [y,m] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID",{month:"long",year:"numeric"}).format(new Date(y,m-1,1));
};
const dateText = value => {
  if (!value) return "—";
  const d = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("id-ID",{day:"2-digit",month:"short",year:"numeric"}).format(d);
};
let app, auth, db, functions, currentUser = null, isEditor = false;
let students = [], payments = [], transactions = [], reports = {}, selectedPeriod = monthNow();

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 3200);
}
function message(text) { $("dataMessage").textContent = text; }
function safeText(value) {
  // All dynamic data is assigned using textContent, never interpolated as HTML.
  return String(value ?? "");
}
function setPeriodOptions(periodIds) {
  const all = [...new Set([monthNow(), ...periodIds])].sort().reverse();
  $("periodSelect").replaceChildren();
  all.forEach(id => {
    const option = document.createElement("option");
    option.value = id; option.textContent = prettyMonth(id);
    $("periodSelect").append(option);
  });
  if (!all.includes(selectedPeriod)) selectedPeriod = all[0];
  $("periodSelect").value = selectedPeriod;
  $("periodLabel").textContent = prettyMonth(selectedPeriod);
}
function renderStudents() {
  const body = $("studentsTable");
  body.replaceChildren();
  if (!students.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 4; td.className = "empty";
    td.textContent = configured ? "Belum ada data siswa pada periode ini." : "Isi konfigurasi Firebase di app.js untuk memuat data.";
    tr.append(td); body.append(tr); return;
  }
  let paid = 0;
  students.forEach(student => {
    const payment = payments.find(p => p.studentId === student.id);
    const isPaid = payment?.status === "paid";
    if (isPaid) paid++;
    const tr = document.createElement("tr");
    const name = document.createElement("td"); name.textContent = student.name;
    const amount = document.createElement("td"); amount.textContent = rupiah(payment?.amount ?? student.feeAmount ?? 0);
    const statusCell = document.createElement("td"), badge = document.createElement("span");
    badge.className = `status ${isPaid ? "paid" : "unpaid"}`; badge.textContent = isPaid ? "Lunas" : "Belum bayar"; statusCell.append(badge);
    const date = document.createElement("td"); date.textContent = isPaid ? dateText(payment.paidAt) : "—";
    tr.append(name, amount, statusCell, date); body.append(tr);
  });
  $("paymentCount").textContent = `${paid} / ${students.length}`;
  $("paymentNote").textContent = "Siswa sudah membayar";
  fillStudentSelect();
}
function renderTransactions() {
  const list = $("transactionsList"); list.replaceChildren();
  if (!transactions.length) {
    const p = document.createElement("p"); p.className = "empty"; p.textContent = "Belum ada transaksi untuk periode ini."; list.append(p); return;
  }
  transactions.forEach(t => {
    const row = document.createElement("div"); row.className = "transaction";
    const icon = document.createElement("div"); icon.className = `transaction-icon ${t.type==="expense"?"expense":""}`; icon.textContent = t.type==="expense" ? "−" : "+";
    const main = document.createElement("div"); main.className = "transaction-main";
    const title = document.createElement("div"); title.className = "transaction-title"; title.textContent = t.description || (t.type==="expense"?"Pengeluaran":"Pemasukan");
    const date = document.createElement("div"); date.className = "transaction-date"; date.textContent = dateText(t.createdAt || t.paidAt);
    main.append(title,date);
    const amount = document.createElement("div"); amount.className = `transaction-amount ${t.type==="expense"?"expense":""}`; amount.textContent = `${t.type==="expense"?"−":"+"}${rupiah(t.amount)}`;
    row.append(icon,main,amount); list.append(row);
  });
}
function fillStudentSelect() {
  const select = $("studentSelect"); if (!select) return;
  const prior = select.value; select.replaceChildren();
  students.forEach(s => { const o = document.createElement("option"); o.value=s.id; o.textContent=s.name; select.append(o); });
  if (students.some(s=>s.id===prior)) select.value=prior;
}
function renderSummary(report) {
  const income = Number(report?.incomeTotal ?? transactions.filter(t=>t.type==="income").reduce((s,t)=>s+Number(t.amount||0),0));
  const expense = Number(report?.expenseTotal ?? transactions.filter(t=>t.type==="expense").reduce((s,t)=>s+Number(t.amount||0),0));
  const opening = Number(report?.openingBalance ?? 0);
  const balance = Number(report?.closingBalance ?? opening + income - expense);
  $("balanceValue").textContent = rupiah(balance);
  $("incomeValue").textContent = rupiah(income);
  $("expenseValue").textContent = rupiah(expense);
}
async function loadData() {
  if (!configured) {
    message("Firebase belum dikonfigurasi. Edit firebaseConfig di public/app.js.");
    renderStudents(); renderTransactions(); renderSummary({});
    return;
  }
  try {
    // Public collections contain only sanitized fields. Never query private collections as viewer.
    const [studentSnap, paymentSnap, transactionSnap, reportSnap, periodsSnap] = await Promise.all([
      getDocs(query(collection(db,"publicStudents"), where("active","==",true))),
      getDocs(query(collection(db,"publicPayments"), where("period","==",selectedPeriod))),
      getDocs(query(collection(db,"publicTransactions"), where("period","==",selectedPeriod), orderBy("createdAt","desc"), limit(100))),
      getDoc(doc(db,"publicReports",selectedPeriod)),
      getDocs(collection(db,"publicPeriods"))
    ]);
    students = studentSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name).localeCompare(String(b.name),"id"));
    payments = paymentSnap.docs.map(d=>({id:d.id,...d.data()}));
    transactions = transactionSnap.docs.map(d=>({id:d.id,...d.data()}));
    reports = reportSnap.exists() ? reportSnap.data() : {};
    setPeriodOptions(periodsSnap.docs.map(d=>d.id));
    renderStudents(); renderTransactions(); renderSummary(reports);
    message("Data berhasil dimuat. Data publik bersifat hanya-baca.");
  } catch (err) {
    console.error(err);
    message("Gagal memuat data. Periksa Firebase config, publikasi data, dan Security Rules.");
  }
}
async function refreshEditorClaim(user) {
  if (!user) { isEditor=false; return; }
  const token = await user.getIdTokenResult(true);
  isEditor = token.claims.role === "editor";
}
function updateRoleUI() {
  $("editorPanel").classList.toggle("hidden", !isEditor);
  $("loginOpen").classList.toggle("hidden", !!currentUser);
  $("logoutBtn").classList.toggle("hidden", !currentUser);
  $("viewerBadge").textContent = isEditor ? "EDITOR" : "VIEWER";
  $("viewerBadge").classList.toggle("role-editor", isEditor);
}
function callable(name) {
  if (!functions) throw new Error("Firebase Functions belum siap.");
  return httpsCallable(functions,name);
}

$("loginOpen").addEventListener("click", () => $("loginDialog").showModal());
$("loginClose").addEventListener("click", () => $("loginDialog").close());
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!configured) { $("loginMessage").textContent="Isi konfigurasi Firebase dahulu."; return; }
  $("loginMessage").textContent="Memeriksa akun…";
  try {
    await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);
    $("loginDialog").close(); $("loginMessage").textContent="";
    toast("Login berhasil.");
  } catch (err) {
    $("loginMessage").textContent="Login gagal. Periksa email/kata sandi atau status akun.";
  }
});
$("logoutBtn").addEventListener("click", async () => {
  await signOut(auth); toast("Kamu sudah keluar.");
});
$("periodSelect").addEventListener("change", async e => {
  selectedPeriod=e.target.value; $("periodLabel").textContent=prettyMonth(selectedPeriod); await loadData();
});
$("printBtn").addEventListener("click", () => window.print());
$("exportCsvBtn").addEventListener("click", () => {
  const rows = [["Nama siswa","Periode","Status","Nominal","Tanggal bayar"]];
  students.forEach(s => {
    const p=payments.find(x=>x.studentId===s.id);
    rows.push([s.name,selectedPeriod,p?.status==="paid"?"Lunas":"Belum bayar",p?.amount ?? s.feeAmount ?? 0,p?.paidAt ? dateText(p.paidAt) : ""]);
  });
  rows.push([]);
  rows.push(["Jenis transaksi","Periode","Keterangan","Nominal","Tanggal"]);
  transactions.forEach(t=>rows.push([t.type,selectedPeriod,t.description||"",t.amount||0,dateText(t.createdAt)]));
  const csv = rows.map(row=>row.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF"+csv],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob), a=document.createElement("a");
  a.href=url;a.download=`laporan-kas-${selectedPeriod}.csv`;a.click();URL.revokeObjectURL(url);
});
$("paymentDate").value = new Date().toISOString().slice(0,10);
$("paymentForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isEditor) return toast("Akses ditolak.");
  const studentId=$("studentSelect").value, amount=Number($("paymentAmount").value), paidAt=$("paymentDate").value;
  if (!studentId || !Number.isSafeInteger(amount) || amount<=0 || !paidAt) return toast("Periksa data pembayaran.");
  try {
    await callable("recordPayment")({studentId,period:selectedPeriod,amount,paidAt});
    toast("Pembayaran berhasil dicatat."); $("paymentAmount").value=""; await loadData();
  } catch (err) { console.error(err); toast(err.message || "Pembayaran gagal disimpan."); }
});
$("transactionForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!isEditor) return toast("Akses ditolak.");
  const type=$("transactionType").value, amount=Number($("transactionAmount").value), description=$("transactionDescription").value.trim();
  if (!Number.isSafeInteger(amount)||amount<=0||!description) return toast("Periksa data transaksi.");
  try {
    await callable("recordTransaction")({type,amount,description,period:selectedPeriod});
    toast("Transaksi berhasil dicatat."); $("transactionAmount").value=""; $("transactionDescription").value=""; await loadData();
  } catch(err) { console.error(err); toast(err.message || "Transaksi gagal disimpan."); }
});

if (configured) {
  app=initializeApp(firebaseConfig); auth=getAuth(app); db=getFirestore(app); functions=getFunctions(app,"asia-southeast1");
  onAuthStateChanged(auth, async user => {
    currentUser=user;
    try { await refreshEditorClaim(user); } catch { isEditor=false; }
    updateRoleUI();
    if (user && !isEditor) toast("Akun ini tidak memiliki role editor.");
    await loadData();
  });
} else {
  updateRoleUI();
  loadData();
}
