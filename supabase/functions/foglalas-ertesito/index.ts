// =====================================================================
// Play Padel – foglalás értesítő (Supabase Edge Function)
//
// Egy adatbázis-webhook hívja meg a `bookings` tábla minden változásakor:
//   INSERT (új foglalás)            → Google Naptár esemény + e-mail a foglalónak + e-mail a tulajdonosnak
//   UPDATE confirmed → cancelled    → esemény törlése + lemondó e-mail mindkettőnek
//   UPDATE cancelled → confirmed    → esemény visszaállítása
//   UPDATE egyéb (kézi módosítás)   → esemény frissítése
//   DELETE (kézi vagy 90 napos törlés) → esemény törlése a naptárból is
//
// Szükséges titkok (Supabase → Edge Functions → Secrets):
//   WEBHOOK_SECRET               – tetszőleges hosszú véletlen szöveg (a webhook fejlécében is ez szerepel)
//   GOOGLE_SERVICE_ACCOUNT_JSON  – a Google szolgáltatásfiók teljes JSON kulcsa
//   GOOGLE_CALENDAR_ID           – a naptár azonosítója (Naptár beállításai → „Naptár azonosítója”)
//   GMAIL_USER                   – a küldő Gmail cím
//   GMAIL_APP_PASSWORD           – a Gmail alkalmazásjelszó (16 karakter)
//   OWNER_EMAIL                  – ide megy az értesítés az új foglalásokról
// Opcionális:
//   SITE_URL                     – a weboldal címe (alapértelmezés: GitHub Pages cím)
// =====================================================================

import nodemailer from 'npm:nodemailer@6.9.16';

const TZ = 'Europe/Budapest';
const COURTS: Record<string, { label: string; colorId: string; hex: string }> = {
  piros: { label: 'Piros', colorId: '11', hex: '#e5484d' },
  zold: { label: 'Zöld', colorId: '10', hex: '#2f9e66' },
  lila: { label: 'Lila', colorId: '3', hex: '#8e4ec6' },
};

type Booking = {
  id: number;
  court: string;
  start_at: string;
  end_at: string;
  name: string;
  phone: string;
  email?: string | null;
  status: 'confirmed' | 'cancelled';
  created_at?: string;
};

type WebhookPayload = {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Booking | null;
  old_record: Booking | null;
};

// ---------------------------------------------------------------------
// Beállítások
// ---------------------------------------------------------------------
function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Hiányzó beállítás (Edge Function secret): ${name}`);
  return v;
}
const SITE_URL = () => Deno.env.get('SITE_URL') || 'https://lederermate.github.io/demo-site/';
const CALENDAR_API = () => Deno.env.get('GOOGLE_CALENDAR_API_BASE') || 'https://www.googleapis.com/calendar/v3';

// ---------------------------------------------------------------------
// HTTP belépési pont
// ---------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = Deno.env.get('WEBHOOK_SECRET');
  if (!secret || !safeEqual(req.headers.get('x-webhook-secret') ?? '', secret)) {
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (payload.schema !== 'public' || payload.table !== 'bookings') {
    return new Response('ignored', { status: 200 });
  }

  const work = handle(payload).catch((e) => console.error('[foglalas-ertesito] váratlan hiba:', e));

  // A Supabase futtatókörnyezetben azonnal válaszolunk, a munka a háttérben fut tovább,
  // így a webhook időkorlátja nem szakítja meg a naptár- és e-mail-műveleteket.
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(work);
    return new Response('accepted', { status: 202 });
  }
  await work;
  return new Response('ok', { status: 200 });
});

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------
// Eseménykezelés
// ---------------------------------------------------------------------
async function handle(p: WebhookPayload): Promise<void> {
  const tasks: Promise<void>[] = [];
  const b = p.record;
  const old = p.old_record;

  if (p.type === 'INSERT' && b && b.status === 'confirmed') {
    tasks.push(step(`#${b.id} naptár`, () => upsertEvent(b)));
    if (b.email) tasks.push(step(`#${b.id} e-mail a foglalónak`, () => send(b.email!, confirmationMail(b), env('OWNER_EMAIL'))));
    tasks.push(step(`#${b.id} e-mail a tulajdonosnak`, () => send(env('OWNER_EMAIL'), ownerMail(b, 'new'), b.email || undefined)));
  } else if (p.type === 'UPDATE' && b && old) {
    if (old.status === 'confirmed' && b.status === 'cancelled') {
      tasks.push(step(`#${b.id} naptár törlés`, () => deleteEvent(b.id)));
      if (b.email && new Date(b.start_at) > new Date()) {
        tasks.push(step(`#${b.id} lemondó e-mail a foglalónak`, () => send(b.email!, cancellationMail(b), env('OWNER_EMAIL'))));
      }
      tasks.push(step(`#${b.id} lemondás e-mail a tulajdonosnak`, () => send(env('OWNER_EMAIL'), ownerMail(b, 'cancelled'), b.email || undefined)));
    } else if (b.status === 'confirmed' && (old.status !== 'confirmed' || changed(old, b))) {
      tasks.push(step(`#${b.id} naptár frissítés`, () => upsertEvent(b)));
    }
  } else if (p.type === 'DELETE' && old) {
    tasks.push(step(`#${old.id} naptár törlés`, () => deleteEvent(old.id)));
  }

  await Promise.all(tasks);
}

function changed(a: Booking, b: Booking): boolean {
  return (['court', 'start_at', 'end_at', 'name', 'phone', 'email'] as const).some((k) => a[k] !== b[k]);
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`[foglalas-ertesito] OK: ${label}`);
  } catch (e) {
    console.error(`[foglalas-ertesito] HIBA: ${label}:`, e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------
// Google Naptár (szolgáltatásfiók, JWT → access token)
// ---------------------------------------------------------------------
let tokenCache: { token: string; exp: number } | null = null;

async function googleToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;

  const sa = JSON.parse(env('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const tokenUrl: string = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    aud: tokenUrl,
    iat: now,
    exp: now + 3600,
  })}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token hiba (${res.status}): ${JSON.stringify(data)}`);
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return tokenCache.token;
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Determinisztikus esemény-azonosító (Google: csak a–v betűk és számjegyek),
// így külön tárolás nélkül is megtaláljuk a foglaláshoz tartozó eseményt.
const eventId = (bookingId: number) => `ppfoglalas${bookingId}`;

async function calendarFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await googleToken();
  const calId = encodeURIComponent(env('GOOGLE_CALENDAR_ID'));
  return fetch(`${CALENDAR_API()}/calendars/${calId}/events${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function upsertEvent(b: Booking): Promise<void> {
  const court = COURTS[b.court] ?? { label: b.court, colorId: '8', hex: '#888' };
  const body = {
    id: eventId(b.id),
    status: 'confirmed',
    summary: `🎾 ${court.label} pálya – ${oneLine(b.name)}`,
    description: [
      `Foglaló: ${oneLine(b.name)}`,
      `Telefon: ${b.phone}`,
      b.email ? `E-mail: ${b.email}` : null,
      `Pálya: ${court.label}`,
      `Időtartam: ${durationText(b)}`,
      `Foglalás azonosító: #${b.id}`,
    ].filter(Boolean).join('\n'),
    start: { dateTime: new Date(b.start_at).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(b.end_at).toISOString(), timeZone: TZ },
    colorId: court.colorId,
    reminders: { useDefault: true },
  };

  // Először frissítés (ez egy korábban törölt eseményt is visszaállít), ha nincs ilyen: létrehozás.
  let res = await calendarFetch(`/${eventId(b.id)}`, { method: 'PUT', body: JSON.stringify(body) });
  if (res.status === 404) {
    res = await calendarFetch('', { method: 'POST', body: JSON.stringify(body) });
  }
  if (!res.ok) throw new Error(`Google Naptár hiba (${res.status}): ${await res.text()}`);
}

async function deleteEvent(bookingId: number): Promise<void> {
  const res = await calendarFetch(`/${eventId(bookingId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new Error(`Google Naptár törlési hiba (${res.status}): ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------
// E-mail (Gmail SMTP, 465-ös port)
// ---------------------------------------------------------------------
type Mail = { subject: string; text: string; html: string };

// deno-lint-ignore no-explicit-any
let transporter: any = null;
function mailer() {
  if (!transporter) {
    const port = Number(Deno.env.get('SMTP_PORT') || 465);
    transporter = nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST') || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: env('GMAIL_USER'), pass: env('GMAIL_APP_PASSWORD').replace(/\s+/g, '') },
    });
  }
  return transporter;
}

async function send(to: string, mail: Mail, replyTo?: string): Promise<void> {
  await mailer().sendMail({
    from: { name: 'Play Padel', address: env('GMAIL_USER') },
    to,
    replyTo,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
}

// ---------------------------------------------------------------------
// Szövegek
// ---------------------------------------------------------------------
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function dayText(iso: string): string {
  return new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
    .format(new Date(iso));
}
function timeText(iso: string): string {
  return new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function durationText(b: Booking): string {
  const min = Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60000);
  return `${String(min / 60).replace('.', ',')} óra`;
}
function details(b: Booking) {
  const court = COURTS[b.court] ?? { label: b.court, colorId: '8', hex: '#888' };
  return {
    court,
    day: dayText(b.start_at),
    from: timeText(b.start_at),
    to: timeText(b.end_at),
    duration: durationText(b),
  };
}

function layout(title: string, intro: string, rows: [string, string][], outro: string, accent: string): string {
  const tr = rows
    .map(([k, v]) => `<tr><td style="padding:8px 0;color:#5a6078;width:140px;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;font-weight:600;color:#1b1f2e">${v}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="hu"><body style="margin:0;background:#f4f5fa;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5fa;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="background:#0f1424;padding:20px 28px;color:#ffffff;font-size:20px;font-weight:bold">Play<span style="color:#d7f34a">Padel</span></td></tr>
<tr><td style="height:6px;background:${accent}"></td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 12px;font-size:22px;color:#1b1f2e">${esc(title)}</h1>
<p style="margin:0 0 16px;color:#333a52;line-height:1.5">${intro}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e3e5ef;border-bottom:1px solid #e3e5ef;margin:8px 0 20px">${tr}</table>
<p style="margin:0;color:#333a52;line-height:1.5">${outro}</p>
</td></tr>
<tr><td style="padding:16px 28px;background:#f4f5fa;color:#5a6078;font-size:12px;line-height:1.5">
Play Padel Budapest · <a href="${SITE_URL()}" style="color:#8e4ec6">${SITE_URL().replace(/^https?:\/\//, '').replace(/\/$/, '')}</a><br>
<a href="${SITE_URL()}adatvedelem.html" style="color:#8e4ec6">Adatkezelési tájékoztató</a>
</td></tr>
</table></td></tr></table></body></html>`;
}

function confirmationMail(b: Booking): Mail {
  const d = details(b);
  const name = oneLine(b.name);
  const subject = `Foglalás visszaigazolás – ${d.court.label} pálya, ${d.day}, ${d.from}`;
  const text = [
    `Kedves ${name}!`,
    '',
    'Köszönjük a foglalásodat, az alábbi időpontot rögzítettük:',
    '',
    `Pálya:       ${d.court.label}`,
    `Nap:         ${d.day}`,
    `Időpont:     ${d.from}–${d.to} (${d.duration})`,
    `Azonosító:   #${b.id}`,
    '',
    'Ha módosítanád vagy lemondanád a foglalást, válaszolj erre az e-mailre.',
    'Kérjük, érkezz 10 perccel korábban. Jó játékot!',
    '',
    'Play Padel Budapest',
    SITE_URL(),
  ].join('\n');
  const html = layout(
    'Foglalásod visszaigazolva 🎾',
    `Kedves ${esc(name)}! Köszönjük a foglalásodat, az alábbi időpontot rögzítettük:`,
    [
      ['Pálya', `<span style="color:${d.court.hex}">●</span> ${esc(d.court.label)} pálya`],
      ['Nap', esc(d.day)],
      ['Időpont', `${esc(d.from)}–${esc(d.to)} (${esc(d.duration)})`],
      ['Azonosító', `#${b.id}`],
    ],
    'Ha módosítanád vagy lemondanád a foglalást, egyszerűen <b>válaszolj erre az e-mailre</b>.<br>Kérjük, érkezz 10 perccel korábban. Jó játékot!',
    d.court.hex,
  );
  return { subject, text, html };
}

function cancellationMail(b: Booking): Mail {
  const d = details(b);
  const name = oneLine(b.name);
  const subject = `Foglalás lemondva – ${d.court.label} pálya, ${d.day}, ${d.from}`;
  const text = [
    `Kedves ${name}!`,
    '',
    'A következő foglalásodat lemondtuk:',
    '',
    `Pálya:       ${d.court.label}`,
    `Nap:         ${d.day}`,
    `Időpont:     ${d.from}–${d.to}`,
    `Azonosító:   #${b.id}`,
    '',
    `Új időpontot a weboldalon foglalhatsz: ${SITE_URL()}#foglalas`,
    'Ha kérdésed van, válaszolj erre az e-mailre.',
    '',
    'Play Padel Budapest',
  ].join('\n');
  const html = layout(
    'Foglalásod lemondva',
    `Kedves ${esc(name)}! A következő foglalásodat lemondtuk:`,
    [
      ['Pálya', `${esc(d.court.label)} pálya`],
      ['Nap', esc(d.day)],
      ['Időpont', `${esc(d.from)}–${esc(d.to)}`],
      ['Azonosító', `#${b.id}`],
    ],
    `Új időpontot a <a href="${SITE_URL()}#foglalas" style="color:#8e4ec6">weboldalon</a> foglalhatsz. Ha kérdésed van, válaszolj erre az e-mailre.`,
    '#5a6078',
  );
  return { subject, text, html };
}

function ownerMail(b: Booking, kind: 'new' | 'cancelled'): Mail {
  const d = details(b);
  const name = oneLine(b.name);
  const isNew = kind === 'new';
  const subject = `${isNew ? 'Új foglalás' : 'Lemondott foglalás'}: ${d.court.label} pálya, ${d.day}, ${d.from}–${d.to} – ${name}`;
  const lines: [string, string][] = [
    ['Pálya', `<span style="color:${d.court.hex}">●</span> ${esc(d.court.label)} pálya`],
    ['Nap', esc(d.day)],
    ['Időpont', `${esc(d.from)}–${esc(d.to)} (${esc(d.duration)})`],
    ['Név', esc(name)],
    ['Telefon', `<a href="tel:${esc(b.phone.replace(/[^0-9+]/g, ''))}" style="color:#1b1f2e">${esc(b.phone)}</a>`],
    ['E-mail', b.email ? `<a href="mailto:${esc(b.email)}" style="color:#1b1f2e">${esc(b.email)}</a>` : '–'],
    ['Azonosító', `#${b.id}`],
  ];
  const text = [
    isNew ? 'Új foglalás érkezett:' : 'Lemondott foglalás:',
    '',
    `Pálya:      ${d.court.label}`,
    `Nap:        ${d.day}`,
    `Időpont:    ${d.from}–${d.to} (${d.duration})`,
    `Név:        ${name}`,
    `Telefon:    ${b.phone}`,
    `E-mail:     ${b.email || '–'}`,
    `Azonosító:  #${b.id}`,
  ].join('\n');
  const html = layout(
    isNew ? 'Új foglalás érkezett' : 'Foglalás lemondva',
    isNew
      ? 'A foglalás bekerült a Google Naptárba is. A foglalónak visszaigazoló e-mailt küldtünk.'
      : 'Az esemény törlődött a Google Naptárból.',
    lines,
    isNew
      ? 'Lemondáshoz a Supabase Table Editorban állítsd a foglalás <b>status</b> mezőjét <b>cancelled</b>-re.'
      : '',
    isNew ? d.court.hex : '#5a6078',
  );
  return { subject, text, html };
}
