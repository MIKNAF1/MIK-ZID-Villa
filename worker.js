/**
 * MIK ZID Villa — Worker API (v2)
 * Availability + Inquiry + Admin panel + Telegram notifications + PayHere checkout.
 *
 * Sources:
 * - Telegram Bot API is HTTP-based and supports sendMessage. https://core.telegram.org/bots/api
 * - PayHere Checkout API uses HTML form POST and notify_url callback. https://support.payhere.lk/api-%26-mobile-sdk/checkout-api
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === "/availability" && request.method === "GET") {
      const checkin = url.searchParams.get("checkin");
      const checkout = url.searchParams.get("checkout");
      if (!checkin || !checkout) return json({ available: false, reason: "Missing dates." }, 400);
      if (checkout <= checkin) return json({ available: false, reason: "Invalid date range." }, 400);

      const overlap = await findOverlap(env, checkin, checkout);
      if (overlap.found) return json({ available: false, reason: "These dates are already booked." }, 200);
      return json({ available: true }, 200);
    }

    if (url.pathname === "/inquiry" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body) return json({ ok: false, error: "Invalid JSON." }, 400);

      const { name, email, phone, guests, checkin, checkout, message, source, preferred_contact, payment_method } = body;
      if (!name || !email || !checkin || !checkout) return json({ ok: false, error: "Missing required fields." }, 400);
      if (checkout <= checkin) return json({ ok: false, error: "Check-out must be after check-in." }, 400);

      const overlap = await findOverlap(env, checkin, checkout);
      if (overlap.found) return json({ ok: false, error: "These dates are already booked." }, 409);

      const deposit = Number(env.DEFAULT_DEPOSIT_LKR || 5000);

      const ins = await supaInsert(env, "bookings", [{
        name,
        email,
        phone: phone || null,
        guests: Number.isFinite(guests) ? guests : null,
        checkin,
        checkout,
        message: message || null,
        status: "inquiry",
        source: source || "website",
        preferred_contact: preferred_contact || null,
        payment_method: payment_method || "pay_later",
        payment_status: "unpaid",
        amount_lkr: deposit
      }]);

      if (!ins.ok) return json({ ok: false, error: "Could not save inquiry.", detail: ins.detail }, 500);

      const booking = ins.rows?.[0];
      await notifyAdmins(env, formatInquiryMsg(booking));
      return json({ ok: true, booking_id: booking?.id }, 200);
    }

    if (url.pathname === "/pay" && request.method === "GET") {
      const bookingId = url.searchParams.get("booking_id");
      if (!bookingId) return html("Missing booking_id", 400);

      const row = await supaGetById(env, "bookings", bookingId);
      if (!row) return html("Booking not found.", 404);

      if (String(row.payment_method || "pay_later") !== "pay_online") {
        return html("This booking is set to Pay Later. No online payment required.", 200);
      }

      const merchant_id = env.PAYHERE_MERCHANT_ID;
      const merchant_secret = env.PAYHERE_MERCHANT_SECRET;
      if (!merchant_id || !merchant_secret) return html("PayHere is not configured yet. Please contact the villa.", 500);

      const currency = env.PAYHERE_CURRENCY || "LKR";
      const amount = Number(row.amount_lkr || env.DEFAULT_DEPOSIT_LKR || 5000).toFixed(2);
      const order_id = `MZV-${row.id}`;

      const hash = await payhereHash(merchant_id, merchant_secret, order_id, amount, currency);

      const return_url = env.PAYHERE_RETURN_URL || "https://example.com/thank-you";
      const cancel_url = env.PAYHERE_CANCEL_URL || "https://example.com/cancelled";
      const notify_url = env.PAYHERE_NOTIFY_URL || (new URL(request.url).origin + "/payhere/notify");
      const checkout_url = env.PAYHERE_CHECKOUT_URL || "https://www.payhere.lk/pay/checkout";

      await supaUpdate(env, "bookings", row.id, { payhere_order_id: order_id });

      const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redirecting…</title>
<style>body{font-family:system-ui,Segoe UI,Roboto,Arial;background:#0f1c2e;color:#fff;margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;}
.card{max-width:520px;width:100%;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:18px;}
.muted{opacity:.75}</style></head><body>
<div class="card"><h2 style="margin:0 0 8px 0;">Redirecting to PayHere…</h2>
<div class="muted">Booking ID: ${escapeHtml(String(row.id))}<br>Amount: LKR ${escapeHtml(String(amount))}</div>
<form id="payhere" method="post" action="${escapeHtml(checkout_url)}">
<input type="hidden" name="merchant_id" value="${escapeHtml(merchant_id)}">
<input type="hidden" name="return_url" value="${escapeHtml(return_url)}">
<input type="hidden" name="cancel_url" value="${escapeHtml(cancel_url)}">
<input type="hidden" name="notify_url" value="${escapeHtml(notify_url)}">
<input type="hidden" name="order_id" value="${escapeHtml(order_id)}">
<input type="hidden" name="items" value="MIK ZID Villa Reservation Deposit">
<input type="hidden" name="currency" value="${escapeHtml(currency)}">
<input type="hidden" name="amount" value="${escapeHtml(amount)}">
<input type="hidden" name="first_name" value="${escapeHtml(firstName(row.name))}">
<input type="hidden" name="last_name" value="${escapeHtml(lastName(row.name))}">
<input type="hidden" name="email" value="${escapeHtml(row.email || '')}">
<input type="hidden" name="phone" value="${escapeHtml(row.phone || '')}">
<input type="hidden" name="address" value="Piliyandala">
<input type="hidden" name="city" value="Colombo">
<input type="hidden" name="country" value="Sri Lanka">
<input type="hidden" name="hash" value="${escapeHtml(hash)}">
<noscript><button type="submit">Continue to PayHere</button></noscript>
</form></div><script>document.getElementById('payhere').submit();</script></body></html>`;
      return html(page, 200);
    }

    if (url.pathname === "/payhere/notify" && request.method === "POST") {
      const bodyText = await request.text();
      const params = new URLSearchParams(bodyText);

      const order_id = params.get("order_id") || "";
      const payment_id = params.get("payment_id") || "";
      const status_code = params.get("status_code") || "";
      const md5sig = params.get("md5sig") || "";
      const amount = params.get("payhere_amount") || "";
      const currency = params.get("payhere_currency") || "";

      const merchant_id = env.PAYHERE_MERCHANT_ID || "";
      const merchant_secret = env.PAYHERE_MERCHANT_SECRET || "";
      if (!merchant_id || !merchant_secret) return new Response("not configured", { status: 500 });

      const booking = await supaGetByOrderId(env, order_id);
      if (!booking) return new Response("ok", { status: 200 });

      // Basic signature check (varies by integration; validate against your PayHere dashboard once live)
      const localSig = await payhereNotifySig(merchant_id, merchant_secret, order_id, payment_id, amount, currency, status_code);
      const isValid = localSig.toUpperCase() === md5sig.toUpperCase();

      if (!isValid) {
        await supaUpdate(env, "bookings", booking.id, { payment_status: "failed", payhere_payment_id: payment_id });
        await notifyAdmins(env, `❌ PayHere signature failed for ${order_id} (booking ${booking.id}).`);
        return new Response("ok", { status: 200 });
      }

      if (String(status_code) === "2") {
        await supaUpdate(env, "bookings", booking.id, { payment_status: "paid", payhere_payment_id: payment_id });
        await notifyAdmins(env, `✅ Payment received! Booking ${booking.id} (${booking.checkin}→${booking.checkout}) Order ${order_id}`);
      } else {
        await supaUpdate(env, "bookings", booking.id, { payment_status: "failed", payhere_payment_id: payment_id });
        await notifyAdmins(env, `⚠️ Payment not completed. Booking ${booking.id} Order ${order_id} status_code=${status_code}`);
      }

      return new Response("ok", { status: 200 });
    }

    // Admin
    if (url.pathname.startsWith("/admin/")) {
      if (!isAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

      if (url.pathname === "/admin/bookings" && request.method === "GET") {
        const status = url.searchParams.get("status");
        const rows = await supaListBookings(env, status);
        return json({ ok: true, rows }, 200);
      }

      const m = url.pathname.match(/^\/admin\/bookings\/(\d+)$/);
      if (m && request.method === "PATCH") {
        const id = Number(m[1]);
        const body = await request.json().catch(() => ({}));
        const patch = {};
        if (body.status) patch.status = String(body.status);
        if (body.payment_status) patch.payment_status = String(body.payment_status);

        if (Object.keys(patch).length === 0) return json({ ok: false, error: "Nothing to update." }, 400);

        const ok = await supaUpdate(env, "bookings", id, patch);
        if (!ok.ok) return json({ ok: false, error: "Update failed.", detail: ok.detail }, 500);

        await notifyAdmins(env, `🛠️ Admin updated booking ${id}: ${Object.entries(patch).map(([k,v])=>`${k}=${v}`).join(", ")}`);
        return json({ ok: true }, 200);
      }

      return json({ ok: false, error: "Not found." }, 404);
    }

    return json({ ok: false, error: "Not found." }, 404);
  }
};

function isAdmin(request, env){const token=request.headers.get("X-Admin-Token")||""; return token && env.ADMIN_TOKEN && token===env.ADMIN_TOKEN;}
function corsHeaders(){return{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PATCH,OPTIONS","Access-Control-Allow-Headers":"Content-Type, X-Admin-Token"};}
function json(obj,status=200){return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json",...corsHeaders()}});}
function html(body,status=200){return new Response(body,{status,headers:{"Content-Type":"text/html; charset=utf-8",...corsHeaders()}});}
function escapeHtml(s){return String(s||"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function firstName(full){const p=String(full||"").trim().split(/\s+/);return p[0]||"Guest";}
function lastName(full){const p=String(full||"").trim().split(/\s+/);return p.slice(1).join(" ")||" ";}

async function notifyAdmins(env,message){
  const token=env.TELEGRAM_BOT_TOKEN;
  const ids=(env.TELEGRAM_CHAT_IDS||"").split(",").map(s=>s.trim()).filter(Boolean);
  if(!token||ids.length===0) return;
  await Promise.all(ids.map(async chat_id=>{
    try{
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id,text:message})
      });
    }catch(_){}
  }));
}

function formatInquiryMsg(b){
  if(!b) return "📩 New inquiry received (details unavailable)";
  return ["📩 New Inquiry — MIK ZID Villa",`Booking ID: ${b.id}`,`Dates: ${b.checkin} → ${b.checkout}`,`Guest: ${b.name} (${b.email}${b.phone?`, ${b.phone}`:""})`,
    `Guests: ${b.guests ?? "-"}`,`Payment: ${b.payment_method || "pay_later"} | Status: ${b.payment_status || "unpaid"} | Amount: LKR ${b.amount_lkr ?? "-"}`,
    b.message ? `Message: ${b.message}` : ""].filter(Boolean).join("\n");
}

function supaHeaders(env){return{"apikey":env.SUPABASE_SERVICE_KEY,"Authorization":`Bearer ${env.SUPABASE_SERVICE_KEY}`};}

async function findOverlap(env, checkin, checkout){
  const query=new URL(`${env.SUPABASE_URL}/rest/v1/bookings`);
  query.searchParams.set("select","id,checkin,checkout,status");
  query.searchParams.set("status","in.(confirmed,blocked)");
  query.searchParams.set("checkin",`lt.${checkout}`);
  query.searchParams.set("checkout",`gt.${checkin}`);
  query.searchParams.set("limit","1");
  const r=await fetch(query.toString(),{headers:supaHeaders(env)});
  if(!r.ok) return {found:false,error:await r.text()};
  const rows=await r.json();
  return {found:rows.length>0};
}

async function supaInsert(env, table, rows){
  const url=`${env.SUPABASE_URL}/rest/v1/${table}`;
  const r=await fetch(url,{method:"POST",headers:{...supaHeaders(env),"Content-Type":"application/json","Prefer":"return=representation"},body:JSON.stringify(rows)});
  if(!r.ok) return {ok:false,detail:await r.text()};
  return {ok:true,rows:await r.json()};
}
async function supaUpdate(env, table, id, patch){
  const url=new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("id",`eq.${id}`);
  const r=await fetch(url.toString(),{method:"PATCH",headers:{...supaHeaders(env),"Content-Type":"application/json"},body:JSON.stringify(patch)});
  if(!r.ok) return {ok:false,detail:await r.text()};
  return {ok:true};
}
async function supaGetById(env, table, id){
  const url=new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("select","*");
  url.searchParams.set("id",`eq.${id}`);
  url.searchParams.set("limit","1");
  const r=await fetch(url.toString(),{headers:supaHeaders(env)});
  if(!r.ok) return null;
  const rows=await r.json();
  return rows[0]||null;
}
async function supaGetByOrderId(env, order_id){
  const url=new URL(`${env.SUPABASE_URL}/rest/v1/bookings`);
  url.searchParams.set("select","*");
  url.searchParams.set("payhere_order_id",`eq.${order_id}`);
  url.searchParams.set("limit","1");
  const r=await fetch(url.toString(),{headers:supaHeaders(env)});
  if(!r.ok) return null;
  const rows=await r.json();
  return rows[0]||null;
}
async function supaListBookings(env, status){
  const url=new URL(`${env.SUPABASE_URL}/rest/v1/bookings`);
  url.searchParams.set("select","*");
  url.searchParams.set("order","id.desc");
  if(status) url.searchParams.set("status",`eq.${status}`);
  const r=await fetch(url.toString(),{headers:supaHeaders(env)});
  if(!r.ok) return [];
  return await r.json();
}

// PayHere checkout hash: md5(merchant_id + order_id + amount + currency + md5(merchant_secret)).toUpperCase()
async function payhereHash(merchant_id, merchant_secret, order_id, amount, currency){
  const secretMd5 = await md5(merchant_secret);
  const raw = `${merchant_id}${order_id}${amount}${currency}${secretMd5}`.toUpperCase();
  return (await md5(raw)).toUpperCase();
}

// Notify signature differs by setup; this is a conservative variant including payment_id
async function payhereNotifySig(merchant_id, merchant_secret, order_id, payment_id, amount, currency, status_code){
  const secretMd5 = await md5(merchant_secret);
  const raw = `${merchant_id}${order_id}${payment_id}${amount}${currency}${status_code}${secretMd5}`.toUpperCase();
  return (await md5(raw)).toUpperCase();
}

async function md5(input){
  const data=new TextEncoder().encode(String(input));
  const digest=await crypto.subtle.digest("MD5",data);
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
