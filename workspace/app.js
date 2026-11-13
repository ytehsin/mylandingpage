// Private workspace: clients, projects, invoices, documents, business details.
// Data lives in Firestore; firestore.rules allow only the owner's Google account.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, serverTimestamp, runTransaction, writeBatch, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { FIREBASE_CONFIG, OWNER_EMAIL } from "./config.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CURRENCIES = ["INR", "USD", "EUR", "GBP"];
const money = (n, cur = "INR") => {
  try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : "en-US", { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(Number(n) || 0); }
  catch { return `${cur} ${(Number(n) || 0).toFixed(2)}`; }
};
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, d) => { const t = new Date(iso); t.setDate(t.getDate() + Number(d || 0)); return t.toISOString().slice(0, 10); };
const fmtDate = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");

// ---------- Firebase ----------
if (FIREBASE_CONFIG.apiKey.startsWith("PASTE")) {
  $("#loading").textContent = "Workspace not connected yet: add the Firebase config to /workspace/config.js.";
  throw new Error("Firebase config missing");
}
const fb = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(fb);
const db = getFirestore(fb);

const state = { clients: [], projects: [], invoices: [], documents: [], business: {}, tab: "dashboard", unsub: [] };

// ---------- Auth ----------
$("#signin").addEventListener("click", async () => {
  $("#gate-err").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { $("#gate-err").textContent = e.code === "auth/popup-closed-by-user" ? "" : "Sign-in failed: " + e.message; }
});
$("#signout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  state.unsub.forEach((u) => u()); state.unsub = [];
  $("#loading").hidden = true;
  if (!user) { $("#app").hidden = true; $("#gate").hidden = false; return; }
  if (user.email !== OWNER_EMAIL || !user.emailVerified) {
    await signOut(auth);
    $("#gate").hidden = false; $("#app").hidden = true;
    $("#gate-err").textContent = `${user.email} is not allowed in this workspace.`;
    return;
  }
  $("#gate").hidden = true; $("#app").hidden = false; $("#who").textContent = user.email;
  subscribe();
});

function subscribe() {
  const listen = (name, key, order) => {
    const q = order ? query(collection(db, name), orderBy(order, "desc")) : collection(db, name);
    state.unsub.push(onSnapshot(q, (snap) => { state[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
      (err) => { $("#main").innerHTML = `<div class="panel"><h2>Can't read data</h2><p class="err">${esc(err.message)}</p><p class="muted">Check that the Firestore rules from firestore.rules are published.</p></div>`; }));
  };
  listen("clients", "clients");
  listen("projects", "projects");
  listen("invoices", "invoices");
  listen("documents", "documents");
  state.unsub.push(onSnapshot(doc(db, "settings", "business"), (d) => { state.business = d.exists() ? d.data() : {}; render(); }));
}

// ---------- Navigation ----------
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  render(); $("#main").focus();
}));

function render() {
  const views = { dashboard: viewDashboard, clients: viewClients, projects: viewProjects, invoices: viewInvoices, documents: viewDocuments, settings: viewSettings };
  $("#main").innerHTML = views[state.tab]();
  bindMain();
}

// ---------- Schemas ----------
const CLIENT_FIELDS = [
  { k: "name", l: "Client name", req: true },
  { k: "company", l: "Company" },
  { k: "type", l: "Type", type: "select", opts: ["LSP", "Direct client", "Platform", "Agency"] },
  { k: "status", l: "Status", type: "select", opts: ["Active", "Prospect", "Inactive"] },
  { k: "contact", l: "Contact person" },
  { k: "email", l: "Email", type: "email" },
  { k: "phone", l: "Phone" },
  { k: "country", l: "Country" },
  { k: "currency", l: "Currency", type: "select", opts: CURRENCIES },
  { k: "rate", l: "Default rate", type: "number" },
  { k: "rateUnit", l: "Rate unit", type: "select", opts: ["per word", "per hour", "per page", "per minute", "per project"] },
  { k: "portal", l: "Vendor portal / link", type: "url" },
  { k: "billingAddress", l: "Billing address (for invoices)", type: "textarea", full: true },
  { k: "taxId", l: "Client GSTIN / VAT ID" },
  { k: "notes", l: "Notes", type: "textarea", full: true },
];
const DOMAINS = ["Software & UI", "AI training & evaluation", "Banking & fintech", "Legal", "Medical & health", "E-learning", "Media & dubbing", "Marketing", "Other"];
const PROJECT_FIELDS = [
  { k: "title", l: "Project", req: true, full: true },
  { k: "clientId", l: "Client", type: "client", req: true },
  { k: "status", l: "Status", type: "select", opts: ["Ongoing", "Delivered", "Invoiced", "Paid", "Cancelled"] },
  { k: "domain", l: "Domain", type: "select", opts: DOMAINS },
  { k: "service", l: "Service", type: "select", opts: ["Translation", "Review", "LQA", "MTPE", "Transcreation", "AI evaluation", "Transcription", "Subtitling", "Other"] },
  { k: "qty", l: "Quantity (words / hours)", type: "number" },
  { k: "unit", l: "Unit", type: "select", opts: ["words", "hours", "pages", "minutes", "project"] },
  { k: "rate", l: "Rate", type: "number" },
  { k: "currency", l: "Currency", type: "select", opts: CURRENCIES },
  { k: "received", l: "Received", type: "date" },
  { k: "deadline", l: "Deadline", type: "date" },
  { k: "po", l: "PO / job number" },
  { k: "notes", l: "Notes", type: "textarea", full: true },
];
const BUSINESS_FIELDS = [
  { sec: "On the invoice" },
  { k: "legalName", l: "Legal name", req: true },
  { k: "displayName", l: "Trading name (optional)" },
  { k: "address", l: "Address", type: "textarea", full: true },
  { k: "email", l: "Email", type: "email" },
  { k: "phone", l: "Phone" },
  { k: "pan", l: "PAN" },
  { k: "gstin", l: "GSTIN (if registered)" },
  { k: "lut", l: "LUT / ARN for export of services (optional)" },
  { sec: "Payment details" },
  { k: "bankName", l: "Bank name" },
  { k: "accountName", l: "Account holder name" },
  { k: "accountNumber", l: "Account number" },
  { k: "ifsc", l: "IFSC" },
  { k: "swift", l: "SWIFT / BIC" },
  { k: "upi", l: "UPI ID" },
  { k: "paypal", l: "PayPal email" },
  { k: "wise", l: "Wise / Payoneer details" },
  { sec: "Invoice defaults" },
  { k: "invoicePrefix", l: "Invoice number prefix", placeholder: "YT-" },
  { k: "nextInvoiceNumber", l: "Next invoice number", type: "number", placeholder: "1" },
  { k: "terms", l: "Payment terms (days)", type: "number", placeholder: "30" },
  { k: "invoiceNotes", l: "Default note on invoices", type: "textarea", full: true },
];

// ---------- Forms ----------
function fieldHtml(f, val) {
  if (f.sec) return `<div class="section-label">${esc(f.sec)}</div>`;
  const id = "f_" + f.k, cls = `field${f.full || f.type === "textarea" ? " full" : ""}`;
  const req = f.req ? " required" : "", ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
  let input;
  if (f.type === "select") input = `<select id="${id}" name="${f.k}"><option value=""></option>${f.opts.map((o) => `<option${o === val ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  else if (f.type === "client") input = `<select id="${id}" name="${f.k}"${req}><option value=""></option>${state.clients.slice().sort((a, b) => a.name.localeCompare(b.name)).map((c) => `<option value="${c.id}"${c.id === val ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  else if (f.type === "textarea") input = `<textarea id="${id}" name="${f.k}"${ph}>${esc(val)}</textarea>`;
  else input = `<input id="${id}" name="${f.k}" type="${f.type || "text"}" value="${esc(val)}"${req}${ph}${f.type === "number" ? ' step="any"' : ""}>`;
  return `<div class="${cls}"><label for="${id}">${esc(f.l)}${f.req ? " *" : ""}</label>${input}</div>`;
}
function readForm(fields) {
  const out = {};
  for (const f of fields) {
    if (f.sec) continue;
    const el = $("#f_" + f.k); if (!el) continue;
    out[f.k] = f.type === "number" ? (el.value === "" ? null : Number(el.value)) : el.value.trim();
  }
  return out;
}

let modalSubmit = null;
function openModal(title, bodyHtml, onSubmit, saveLabel = "Save", wide = false) {
  $("#modal").classList.toggle("modal--wide", wide);
  $("#modal-title").textContent = title; $("#modal-body").innerHTML = bodyHtml; $("#modal-err").textContent = "";
  $("#modal-save").textContent = saveLabel; modalSubmit = onSubmit; $("#modal").showModal();
}
$("#modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#modal-save"); btn.disabled = true; $("#modal-err").textContent = "";
  try { await modalSubmit(); $("#modal").close(); }
  catch (err) { $("#modal-err").textContent = err.message; }
  finally { btn.disabled = false; }
});
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => $("#modal").close()));

function requireFields(fields, data) {
  for (const f of fields) if (f.req && (data[f.k] === "" || data[f.k] == null)) throw new Error(`${f.l} is required.`);
}

// ---------- Dashboard ----------
const clientName = (id) => state.clients.find((c) => c.id === id)?.name || "—";
const invTotal = (inv) => { const sub = (inv.items || []).reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.rate) || 0), 0); return sub + sub * (Number(inv.taxRate) || 0) / 100; };
const invStatus = (inv) => (inv.status === "Sent" && inv.dueDate && inv.dueDate < today() ? "Overdue" : inv.status);
const sumBy = (list, f) => list.reduce((m, x) => { const c = x.currency || "INR"; m[c] = (m[c] || 0) + f(x); return m; }, {});
const moneyMap = (m) => Object.entries(m).filter(([, v]) => v).map(([c, v]) => money(v, c)).join(" + ") || money(0);

function viewDashboard() {
  const open = state.projects.filter((p) => p.status === "Ongoing");
  const unpaid = state.invoices.filter((i) => ["Sent"].includes(i.status));
  const month = today().slice(0, 7);
  const thisMonth = state.invoices.filter((i) => (i.date || "").startsWith(month) && i.status !== "Cancelled");
  const uninvoiced = state.projects.filter((p) => p.status === "Delivered");
  const upcoming = open.filter((p) => p.deadline).sort((a, b) => a.deadline.localeCompare(b.deadline)).slice(0, 8);
  return `
  <div class="page-head"><h1>Dashboard</h1><div class="toolbar"><button class="btn btn--primary btn--sm" data-act="new-project">+ Project</button><button class="btn btn--ghost btn--sm" data-act="new-invoice">+ Invoice</button></div></div>
  <div class="cards">
    <div class="kpi"><b>${state.clients.filter((c) => c.status === "Active").length}</b><span>active clients</span></div>
    <div class="kpi"><b>${open.length}</b><span>ongoing projects</span></div>
    <div class="kpi"><b>${esc(moneyMap(sumBy(unpaid, invTotal)))}</b><span>unpaid (${unpaid.length} invoices)</span></div>
    <div class="kpi"><b>${esc(moneyMap(sumBy(thisMonth, invTotal)))}</b><span>invoiced this month</span></div>
  </div>
  <div class="panel"><h2>Upcoming deadlines</h2>${upcoming.length ? table(["Deadline", "Project", "Client", "Words/qty"], upcoming.map((p) => [fmtDate(p.deadline), esc(p.title), esc(clientName(p.clientId)), { num: p.qty ?? "" }])) : `<p class="muted">No ongoing projects with deadlines.</p>`}</div>
  <div class="panel"><h2>Delivered, not yet invoiced</h2>${uninvoiced.length ? table(["Project", "Client", "Value"], uninvoiced.map((p) => [esc(p.title), esc(clientName(p.clientId)), { num: money((p.qty || 0) * (p.rate || 0), p.currency) }])) : `<p class="muted">Nothing waiting to be invoiced.</p>`}</div>
  <div class="panel"><h2>Overdue invoices</h2>${(() => { const od = state.invoices.filter((i) => invStatus(i) === "Overdue"); return od.length ? table(["Invoice", "Client", "Due", "Amount"], od.map((i) => [esc(i.number), esc(clientName(i.clientId)), fmtDate(i.dueDate), { num: money(invTotal(i), i.currency) }])) : `<p class="muted">None overdue.</p>`; })()}</div>`;
}

function table(head, rows) {
  return `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => (c && typeof c === "object" ? (c.num !== undefined ? `<td class="num">${esc(c.num)}</td>` : `<td class="actions">${c.html}</td>`) : `<td>${c}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
}
const pill = (s) => (s ? `<span class="pill ${esc(s)}">${esc(s)}</span>` : "");

// ---------- Clients ----------
let clientFilter = "";
function viewClients() {
  const q = clientFilter.toLowerCase();
  const list = state.clients.filter((c) => !q || [c.name, c.company, c.type, c.email, c.country].join(" ").toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="page-head"><h1>Clients</h1><div class="toolbar"><input type="search" id="client-q" placeholder="Search clients" value="${esc(clientFilter)}"><button class="btn btn--ghost btn--sm" data-act="export-clients">Export CSV</button><button class="btn btn--primary btn--sm" data-act="new-client">+ Client</button></div></div>
  ${list.length ? table(["Client", "Type", "Status", "Contact", "Rate", "Projects", ""], list.map((c) => [
    `<b>${esc(c.name)}</b>${c.company ? `<br><span class="muted">${esc(c.company)}</span>` : ""}`, esc(c.type), pill(c.status),
    `${esc(c.contact)}${c.email ? `<br><a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}`,
    c.rate != null ? esc(`${c.currency || ""} ${c.rate} ${c.rateUnit || ""}`) : "",
    { num: state.projects.filter((p) => p.clientId === c.id).length },
    { html: `<button class="link" data-act="edit-client" data-id="${c.id}">Edit</button><button class="link" data-act="del-client" data-id="${c.id}">Delete</button>` },
  ])) : `<div class="table-wrap"><p class="empty">No clients yet. Add your first one.</p></div>`}`;
}
function editClient(id) {
  const c = state.clients.find((x) => x.id === id) || { status: "Active", currency: "INR", rateUnit: "per word" };
  openModal(id ? "Edit client" : "New client", CLIENT_FIELDS.map((f) => fieldHtml(f, c[f.k])).join(""), async () => {
    const data = readForm(CLIENT_FIELDS); requireFields(CLIENT_FIELDS, data);
    if (id) await updateDoc(doc(db, "clients", id), { ...data, updatedAt: serverTimestamp() });
    else await addDoc(collection(db, "clients"), { ...data, createdAt: serverTimestamp() });
  });
}

// ---------- Projects ----------
let projectFilter = { q: "", status: "" };
function viewProjects() {
  const q = projectFilter.q.toLowerCase();
  const list = state.projects.filter((p) => (!projectFilter.status || p.status === projectFilter.status) && (!q || [p.title, clientName(p.clientId), p.domain, p.service, p.po].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (b.received || "").localeCompare(a.received || ""));
  const statuses = ["", "Ongoing", "Delivered", "Invoiced", "Paid", "Cancelled"];
  return `<div class="page-head"><h1>Projects</h1><div class="toolbar"><input type="search" id="project-q" placeholder="Search projects" value="${esc(projectFilter.q)}"><select id="project-status">${statuses.map((s) => `<option value="${s}"${s === projectFilter.status ? " selected" : ""}>${s || "All statuses"}</option>`).join("")}</select><button class="btn btn--ghost btn--sm" data-act="export-projects">Export CSV</button><button class="btn btn--primary btn--sm" data-act="new-project">+ Project</button></div></div>
  ${list.length ? table(["Project", "Client", "Domain", "Qty", "Value", "Deadline", "Status", ""], list.map((p) => [
    `<b>${esc(p.title)}</b>${p.service ? `<br><span class="muted">${esc(p.service)}${p.po ? " · " + esc(p.po) : ""}</span>` : ""}`, esc(clientName(p.clientId)), esc(p.domain),
    { num: p.qty != null ? `${p.qty} ${p.unit || ""}` : "" }, { num: p.rate != null ? money((p.qty || 0) * p.rate, p.currency) : "" }, fmtDate(p.deadline), pill(p.status),
    { html: `<button class="link" data-act="edit-project" data-id="${p.id}">Edit</button><button class="link" data-act="del-project" data-id="${p.id}">Delete</button>` },
  ])) : `<div class="table-wrap"><p class="empty">No projects match.</p></div>`}`;
}
function editProject(id) {
  const p = state.projects.find((x) => x.id === id) || { status: "Ongoing", unit: "words", currency: "INR", received: today() };
  openModal(id ? "Edit project" : "New project", PROJECT_FIELDS.map((f) => fieldHtml(f, p[f.k])).join(""), async () => {
    const data = readForm(PROJECT_FIELDS); requireFields(PROJECT_FIELDS, data);
    if (id) await updateDoc(doc(db, "projects", id), { ...data, updatedAt: serverTimestamp() });
    else await addDoc(collection(db, "projects"), { ...data, createdAt: serverTimestamp() });
  });
  // Prefill rate and currency from the chosen client
  $("#f_clientId").addEventListener("change", (e) => {
    const c = state.clients.find((x) => x.id === e.target.value); if (!c) return;
    if (c.currency) $("#f_currency").value = c.currency;
    if (c.rate != null && !$("#f_rate").value) $("#f_rate").value = c.rate;
  });
}

// ---------- Invoices ----------
function viewInvoices() {
  const list = state.invoices.slice().sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.number || "").localeCompare(a.number || ""));
  return `<div class="page-head"><h1>Invoices</h1><div class="toolbar"><button class="btn btn--primary btn--sm" data-act="new-invoice">+ Invoice</button></div></div>
  ${!state.business.legalName ? `<div class="panel"><p>Add your <button class="link" data-tab-go="settings">business details</button> first; they appear on every invoice.</p></div>` : ""}
  ${list.length ? table(["Invoice", "Date", "Client", "Due", "Amount", "Status", ""], list.map((i) => [
    `<b>${esc(i.number)}</b>`, fmtDate(i.date), esc(clientName(i.clientId)), fmtDate(i.dueDate), { num: money(invTotal(i), i.currency) }, pill(invStatus(i)),
    { html: `<button class="link" data-act="print-invoice" data-id="${i.id}">PDF</button><button class="link" data-act="edit-invoice" data-id="${i.id}">Edit</button>${i.status === "Sent" ? `<button class="link" data-act="paid-invoice" data-id="${i.id}">Mark paid</button>` : ""}<button class="link" data-act="del-invoice" data-id="${i.id}">Delete</button>` },
  ])) : `<div class="table-wrap"><p class="empty">No invoices yet.</p></div>`}`;
}

function itemRow(it = {}) {
  return `<div class="item-row"><input class="i-desc" placeholder="Description" value="${esc(it.desc)}"><input class="i-qty" type="number" step="any" placeholder="Qty" value="${esc(it.qty)}"><input class="i-unit" placeholder="Unit" value="${esc(it.unit ?? "words")}"><input class="i-rate" type="number" step="any" placeholder="Rate" value="${esc(it.rate)}"><span class="amt"></span><button type="button" class="link rm" aria-label="Remove line">✕</button></div>`;
}
function readItems() {
  return [...document.querySelectorAll("#item-list .item-row")].map((r) => ({
    desc: $(".i-desc", r).value.trim(), qty: Number($(".i-qty", r).value) || 0, unit: $(".i-unit", r).value.trim(), rate: Number($(".i-rate", r).value) || 0,
  })).filter((i) => i.desc || i.qty || i.rate);
}
function refreshTotals() {
  const cur = $("#f_currency").value || "INR", tax = Number($("#f_taxRate").value) || 0;
  let sub = 0;
  document.querySelectorAll("#item-list .item-row").forEach((r) => { const a = (Number($(".i-qty", r).value) || 0) * (Number($(".i-rate", r).value) || 0); sub += a; $(".amt", r).textContent = money(a, cur); });
  $("#inv-totals").innerHTML = `Subtotal ${money(sub, cur)}${tax ? `<br>${esc($("#f_taxLabel").value || "Tax")} (${tax}%) ${money(sub * tax / 100, cur)}` : ""}<br><b>Total ${money(sub + sub * tax / 100, cur)}</b>`;
}

function editInvoice(id) {
  const b = state.business;
  const inv = state.invoices.find((x) => x.id === id) || { date: today(), dueDate: addDays(today(), b.terms ?? 30), currency: "INR", status: "Draft", items: [], notes: b.invoiceNotes || "", taxLabel: "IGST", taxRate: 0, projectIds: [] };
  const fields = [
    { k: "clientId", l: "Client", type: "client", req: true },
    { k: "status", l: "Status", type: "select", opts: ["Draft", "Sent", "Paid", "Cancelled"] },
    { k: "date", l: "Invoice date", type: "date", req: true },
    { k: "dueDate", l: "Due date", type: "date" },
    { k: "currency", l: "Currency", type: "select", opts: CURRENCIES },
    { k: "taxLabel", l: "Tax label (e.g. IGST, GST, VAT)" },
    { k: "taxRate", l: "Tax %", type: "number" },
  ];
  const body = fields.map((f) => fieldHtml(f, inv[f.k])).join("") +
    `<div id="proj-pick" class="checklist" hidden></div>
     <div class="section-label">Line items</div>
     <div class="items"><div class="item-row item-head"><span>Description</span><span>Qty</span><span>Unit</span><span>Rate</span><span class="amt">Amount</span><span></span></div><div id="item-list">${(inv.items.length ? inv.items : [{}]).map(itemRow).join("")}</div><button type="button" class="link" id="add-item" style="align-self:flex-start">+ Add line</button></div>
     ${fieldHtml({ k: "notes", l: "Note on invoice", type: "textarea", full: true }, inv.notes)}
     <div class="totals" id="inv-totals"></div>`;

  openModal(id ? `Edit invoice ${inv.number}` : "New invoice", body, async () => {
    const data = readForm(fields.concat([{ k: "notes", type: "textarea" }])); requireFields(fields, data);
    data.items = readItems(); if (!data.items.length) throw new Error("Add at least one line item.");
    const picked = [...document.querySelectorAll("#proj-pick input:checked")].map((x) => x.value);
    data.projectIds = [...new Set([...(inv.projectIds || []), ...picked])];
    if (id) {
      await updateDoc(doc(db, "invoices", id), { ...data, updatedAt: serverTimestamp() });
    } else {
      // Assign the next invoice number atomically
      const ref = doc(collection(db, "invoices"));
      await runTransaction(db, async (tx) => {
        const sRef = doc(db, "settings", "business"); const s = await tx.get(sRef);
        const n = Number(s.exists() && s.data().nextInvoiceNumber) || 1, prefix = (s.exists() && s.data().invoicePrefix) || "YT-";
        const number = `${prefix}${String(n).padStart(4, "0")}`;
        tx.set(ref, { ...data, number, createdAt: serverTimestamp() });
        tx.set(sRef, { nextInvoiceNumber: n + 1 }, { merge: true });
      });
      if (picked.length) { const batch = writeBatch(db); picked.forEach((pid) => batch.update(doc(db, "projects", pid), { status: "Invoiced", invoiceId: ref.id })); await batch.commit(); }
    }
  }, id ? "Save invoice" : "Create invoice", true);

  const showProjects = () => {
    const cid = $("#f_clientId").value, box = $("#proj-pick");
    const ps = state.projects.filter((p) => p.clientId === cid && p.status === "Delivered" && !p.invoiceId);
    box.hidden = !ps.length;
    box.innerHTML = ps.length ? `<b>Delivered projects for this client: tick to add as lines</b>` + ps.map((p) => `<label><input type="checkbox" value="${p.id}"> ${esc(p.title)} · ${esc(p.qty ?? "")} ${esc(p.unit || "")} × ${esc(p.rate ?? "")}</label>`).join("") : "";
    box.querySelectorAll("input").forEach((cb) => cb.addEventListener("change", () => {
      const p = state.projects.find((x) => x.id === cb.value);
      if (cb.checked) {
        const list = $("#item-list"); const first = list.querySelector(".item-row");
        if (first && !readItems().length) first.remove();
        list.insertAdjacentHTML("beforeend", itemRow({ desc: [p.service, p.title].filter(Boolean).join(": ") + (p.po ? ` (PO ${p.po})` : ""), qty: p.qty, unit: p.unit, rate: p.rate }));
        if (p.currency) $("#f_currency").value = p.currency;
        bindItems(); refreshTotals();
      }
    }));
    const c = state.clients.find((x) => x.id === cid); if (c?.currency && !id) $("#f_currency").value = c.currency;
    refreshTotals();
  };
  const bindItems = () => document.querySelectorAll("#item-list .item-row").forEach((r) => {
    r.querySelectorAll("input").forEach((i) => (i.oninput = refreshTotals));
    const rm = $(".rm", r); if (rm) rm.onclick = () => { r.remove(); refreshTotals(); };
  });
  $("#add-item").onclick = () => { $("#item-list").insertAdjacentHTML("beforeend", itemRow()); bindItems(); };
  $("#f_clientId").addEventListener("change", showProjects);
  ["#f_currency", "#f_taxRate", "#f_taxLabel"].forEach((s) => $(s).addEventListener("input", refreshTotals));
  bindItems(); if (!id) showProjects(); refreshTotals();
}

function printInvoice(id) {
  const inv = state.invoices.find((x) => x.id === id); if (!inv) return;
  const b = state.business, c = state.clients.find((x) => x.id === inv.clientId) || {}, cur = inv.currency || "INR";
  const sub = (inv.items || []).reduce((s, i) => s + i.qty * i.rate, 0), tax = sub * (Number(inv.taxRate) || 0) / 100;
  const pay = [["Bank", b.bankName], ["Account name", b.accountName], ["Account no.", b.accountNumber], ["IFSC", b.ifsc], ["SWIFT", b.swift], ["UPI", b.upi], ["PayPal", b.paypal], ["Wise / Payoneer", b.wise]].filter(([, v]) => v);
  $("#print-area").innerHTML = `<div class="inv">
    <div class="inv-top"><div><h1>${esc(b.displayName || b.legalName || "")}</h1>${b.displayName && b.legalName ? `<div>${esc(b.legalName)}</div>` : ""}<pre>${esc(b.address)}</pre><div>${esc([b.email, b.phone].filter(Boolean).join(" · "))}</div><div>${esc([b.pan && "PAN " + b.pan, b.gstin && "GSTIN " + b.gstin].filter(Boolean).join(" · "))}</div></div>
      <div class="inv-meta"><h1>Invoice</h1><div><b>${esc(inv.number)}</b></div><div>Date: ${fmtDate(inv.date)}</div>${inv.dueDate ? `<div>Due: ${fmtDate(inv.dueDate)}</div>` : ""}</div></div>
    <div class="inv-parties"><div><h3>Bill to</h3><b>${esc(c.company || c.name)}</b>${c.company && c.contact ? `<div>Attn: ${esc(c.contact)}</div>` : ""}<pre>${esc(c.billingAddress)}</pre>${c.taxId ? `<div>Tax ID: ${esc(c.taxId)}</div>` : ""}${c.email ? `<div>${esc(c.email)}</div>` : ""}</div>
      <div>${b.lut && cur !== "INR" ? `<h3>Export of services</h3><div>Supply meant for export under LUT ${esc(b.lut)} without payment of IGST.</div>` : ""}</div></div>
    <table><thead><tr><th>Description</th><th class="r">Qty</th><th>Unit</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${(inv.items || []).map((i) => `<tr><td>${esc(i.desc)}</td><td class="r">${esc(i.qty)}</td><td>${esc(i.unit)}</td><td class="r">${esc(money(i.rate, cur))}</td><td class="r">${esc(money(i.qty * i.rate, cur))}</td></tr>`).join("")}</tbody></table>
    <div class="inv-totals"><div><span>Subtotal</span><span>${money(sub, cur)}</span></div>${inv.taxRate ? `<div><span>${esc(inv.taxLabel || "Tax")} (${esc(inv.taxRate)}%)</span><span>${money(tax, cur)}</span></div>` : ""}<div class="grand"><span>Total (${cur})</span><span>${money(sub + tax, cur)}</span></div></div>
    <div class="inv-foot"><div>${pay.length ? `<h3>Payment details</h3>${pay.map(([k, v]) => `<div>${esc(k)}: ${esc(v)}</div>`).join("")}` : ""}</div><div>${inv.notes ? `<h3>Note</h3><pre>${esc(inv.notes)}</pre>` : ""}</div></div>
  </div>`;
  const prevTitle = document.title; document.title = `${inv.number} ${c.company || c.name || ""}`.trim();
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); document.title = prevTitle; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done); window.print(); setTimeout(done, 1500);
}

// ---------- Documents (stored in Firestore in chunks; free plan, no Storage bucket needed) ----------
const CHUNK = 700 * 1024, MAX_FILE = 8 * 1024 * 1024;
function viewDocuments() {
  const list = state.documents.slice().sort((a, b) => (a.tag || "").localeCompare(b.tag || "") || a.name.localeCompare(b.name));
  return `<div class="page-head"><h1>Documents</h1><div class="toolbar"><button class="btn btn--primary btn--sm" data-act="upload-doc">+ Upload</button></div></div>
  <p class="muted" style="margin-bottom:16px">Your CVs, certificates, NDAs and templates. Up to 8 MB per file.</p>
  ${list.length ? table(["Name", "Category", "Size", "Uploaded", ""], list.map((d) => [
    `<b>${esc(d.label || d.name)}</b>${d.label ? `<br><span class="muted">${esc(d.name)}</span>` : ""}`, esc(d.tag), { num: (d.size / 1024).toFixed(0) + " KB" }, d.uploaded ? fmtDate(d.uploaded) : "",
    { html: `<button class="link" data-act="download-doc" data-id="${d.id}">Download</button><button class="link" data-act="del-doc" data-id="${d.id}">Delete</button>` },
  ])) : `<div class="table-wrap"><p class="empty">No documents yet. Upload your CVs here.</p></div>`}`;
}
function uploadDoc() {
  openModal("Upload document", `
    <div class="field full"><label for="f_file">File *</label><input id="f_file" type="file" required></div>
    ${fieldHtml({ k: "label", l: "Display name (e.g. CV: Software & UI)" })}
    ${fieldHtml({ k: "tag", l: "Category", type: "select", opts: ["CV", "Certificate", "NDA / contract", "Template", "Sample", "Other"] }, "CV")}`, async () => {
    const file = $("#f_file").files[0]; if (!file) throw new Error("Choose a file.");
    if (file.size > MAX_FILE) throw new Error("File is larger than 8 MB.");
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
    const ref = doc(collection(db, "documents")); const parts = Math.ceil(b64.length / CHUNK) || 1;
    for (let i = 0; i < parts; i++) await setDoc(doc(db, "documents", ref.id, "chunks", String(i)), { i, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
    await setDoc(ref, { name: file.name, type: file.type || "application/octet-stream", size: file.size, parts, label: $("#f_label").value.trim(), tag: $("#f_tag").value, uploaded: today(), createdAt: serverTimestamp() });
  }, "Upload");
}
async function downloadDoc(id) {
  const d = state.documents.find((x) => x.id === id); if (!d) return;
  const snap = await getDocs(collection(db, "documents", id, "chunks"));
  const b64 = snap.docs.map((x) => x.data()).sort((a, b) => a.i - b.i).map((x) => x.data).join("");
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: d.type }));
  const a = document.createElement("a"); a.href = url; a.download = d.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
async function deleteDocument(id) {
  const snap = await getDocs(collection(db, "documents", id, "chunks"));
  const batch = writeBatch(db); snap.docs.forEach((x) => batch.delete(x.ref)); batch.delete(doc(db, "documents", id)); await batch.commit();
}

// ---------- Settings ----------
function viewSettings() {
  const b = state.business;
  return `<div class="page-head"><h1>Business details</h1></div>
  <div class="panel"><p class="muted" style="margin-bottom:16px">Used on your invoices. Stored only in your private database.</p>
  <form id="biz-form" class="modal-body" style="padding:0">${BUSINESS_FIELDS.map((f) => fieldHtml(f, b[f.k])).join("")}
  <div class="field full" style="flex-direction:row;gap:12px;align-items:center"><button class="btn btn--primary btn--sm" type="submit">Save details</button><span class="muted" id="biz-msg"></span></div></form></div>`;
}

// ---------- CSV export ----------
function csv(rows) { return rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n"); }
function downloadText(name, text) { const url = URL.createObjectURL(new Blob([text], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000); }

// ---------- Event binding ----------
function bindMain() {
  const main = $("#main");
  main.querySelectorAll("[data-tab-go]").forEach((b) => b.addEventListener("click", () => $(`.tabs [data-tab="${b.dataset.tabGo}"]`).click()));
  const cq = $("#client-q", main); if (cq) cq.addEventListener("input", (e) => { clientFilter = e.target.value; const pos = e.target.selectionStart; render(); const n = $("#client-q"); n.focus(); n.setSelectionRange(pos, pos); });
  const pq = $("#project-q", main); if (pq) pq.addEventListener("input", (e) => { projectFilter.q = e.target.value; const pos = e.target.selectionStart; render(); const n = $("#project-q"); n.focus(); n.setSelectionRange(pos, pos); });
  const ps = $("#project-status", main); if (ps) ps.addEventListener("change", (e) => { projectFilter.status = e.target.value; render(); });
  const biz = $("#biz-form", main);
  if (biz) biz.addEventListener("submit", async (e) => {
    e.preventDefault(); const data = readForm(BUSINESS_FIELDS);
    try { requireFields(BUSINESS_FIELDS, data); await setDoc(doc(db, "settings", "business"), { ...data, updatedAt: serverTimestamp() }, { merge: true }); $("#biz-msg").textContent = "Saved."; }
    catch (err) { $("#biz-msg").textContent = err.message; }
  });
  main.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.id, act = b.dataset.act;
    const confirmDel = (what) => window.confirm(`Delete this ${what}? This can't be undone.`);
    try {
      if (act === "new-client") editClient();
      if (act === "edit-client") editClient(id);
      if (act === "del-client") { if (state.projects.some((p) => p.clientId === id)) return alert("This client has projects. Delete or reassign them first."); if (confirmDel("client")) await deleteDoc(doc(db, "clients", id)); }
      if (act === "new-project") editProject();
      if (act === "edit-project") editProject(id);
      if (act === "del-project" && confirmDel("project")) await deleteDoc(doc(db, "projects", id));
      if (act === "new-invoice") { if (!state.clients.length) return alert("Add a client first."); editInvoice(); }
      if (act === "edit-invoice") editInvoice(id);
      if (act === "print-invoice") printInvoice(id);
      if (act === "paid-invoice") {
        const inv = state.invoices.find((x) => x.id === id);
        await updateDoc(doc(db, "invoices", id), { status: "Paid", paidDate: today() });
        if (inv?.projectIds?.length) { const batch = writeBatch(db); inv.projectIds.forEach((pid) => batch.update(doc(db, "projects", pid), { status: "Paid" })); await batch.commit(); }
      }
      if (act === "del-invoice" && confirmDel("invoice")) await deleteDoc(doc(db, "invoices", id));
      if (act === "upload-doc") uploadDoc();
      if (act === "download-doc") await downloadDoc(id);
      if (act === "del-doc" && confirmDel("document")) await deleteDocument(id);
      if (act === "export-clients") downloadText(`clients-${today()}.csv`, csv([CLIENT_FIELDS.map((f) => f.l), ...state.clients.map((c) => CLIENT_FIELDS.map((f) => c[f.k]))]));
      if (act === "export-projects") downloadText(`projects-${today()}.csv`, csv([PROJECT_FIELDS.map((f) => f.l), ...state.projects.map((p) => PROJECT_FIELDS.map((f) => (f.k === "clientId" ? clientName(p.clientId) : p[f.k])))]));
    } catch (err) { alert(err.message); }
  }));
}
