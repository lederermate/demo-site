// =====================================================================
// Play Padel – AI asszisztens (Supabase Edge Function + Claude API)
//
// A weboldal chat-ablaka hívja. A beszélgetést a böngésző tárolja (sessionStorage),
// a szerver nem menti; minden kérésben visszaküldi a teljes, változatlan előzményt.
//
// Eszközök (tool use):
//   get_availability  – szabad időpontok egy adott napra (a foglalási adatbázisból)
//   prepare_booking   – egy szabad időpont kijelölése a weboldal foglalási naptárában.
//                       A foglalást NEM hozza létre: nevet, telefonszámot, e-mailt és az
//                       adatkezelési hozzájárulást a látogató az űrlapon adja meg.
//
// Szükséges titok (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY  – Claude API kulcs (console.anthropic.com)
// Opcionális:
//   CHAT_ALLOWED_ORIGINS – vesszővel elválasztott engedélyezett weboldal-címek
//   CHAT_DAILY_LIMIT_PER_IP (alap: 40), CHAT_DAILY_LIMIT_TOTAL (alap: 1000)
// A SUPABASE_URL és SUPABASE_SERVICE_ROLE_KEY-t a Supabase automatikusan biztosítja.
// =====================================================================

import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';

const MODEL = 'claude-opus-5-5';
const TZ = 'Europe/Budapest';
const DAYS_AHEAD = 14;            // a weboldal naptára ennyi napot mutat
const CLOSE_MIN = 22 * 60;
const MAX_HISTORY_MESSAGES = 60;  // ennél hosszabb beszélgetést nem folytatunk
const MAX_USER_CHARS = 1000;      // egy üzenet maximális hossza
const MAX_BODY_BYTES = 400_000;
const MAX_TOOL_ROUNDS = 5;

const COURTS: Record<string, string> = { piros: 'Piros', zold: 'Zöld', lila: 'Lila' };

const DEFAULT_ORIGINS = ['https://lederermate.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
// A projekt nyilvános (publishable) kulcsa – ugyanaz, ami a weboldal config.js-ében is szerepel.
const PUBLIC_KEY_FALLBACK = 'sb_publishable_LcPN3pjPTcc9XulNSSvdig_Qlb6saFR';

// ---------------------------------------------------------------------
// Tudásbázis (TESZTADATOK – a próba projekthez)
// ---------------------------------------------------------------------
const SYSTEM_PROMPT = `Te a Play Padel budapesti padelközpont weboldalának segítőkész asszisztense vagy. A weboldal bal alsó sarkában lévő chat-ablakban beszélgetsz a látogatókkal.

## Feladataid
1. Segítesz pályát foglalni: szabad időpontot keresel, és kijelölöd a weboldal foglalási naptárában.
2. Válaszolsz a padel szabályaival és játékmenetével kapcsolatos kérdésekre.
3. Válaszolsz a Play Padellel kapcsolatos kérdésekre (nyitvatartás, elérhetőség, árak, megközelítés, szolgáltatások).

## Stílus
- Alapból magyarul válaszolj; ha a látogató más nyelven ír, azon a nyelven.
- Tegeződj, legyél barátságos és tömör: általában 1–4 mondat vagy egy rövid lista. Chat-ablakban vagy, kerüld a hosszú bekezdéseket és a címsorokat.
- Formázásnak csak **félkövért** és "- " kezdetű listát használj.

## Foglalás menete
- Online legfeljebb ${DAYS_AHEAD} napra előre lehet foglalni, egész vagy fél órás kezdéssel, 1, 1,5 vagy 2 órára.
- Ha a látogató foglalna, tisztázd a napot, a kezdést (vagy napszakot), az időtartamot és – ha számít neki – a pályát. Ami hiányzik, arra kérdezz rá röviden; ha a pálya mindegy, válassz egy szabadot.
- Mindig a get_availability eszközzel nézd meg a foglaltságot, ne találgass. Ha a kért időpont foglalt, ajánlj fel a közelben lévő szabad időpontokat.
- Ha a látogató megerősítette az időpontot, hívd meg a prepare_booking eszközt. Ez csak kijelöli az időpontot a weboldal naptárában – a foglalás akkor jön létre, amikor a látogató az űrlapon megadja a nevét, telefonszámát, e-mail címét, elfogadja az adatkezelési tájékoztatót, és a „Foglalás elküldése” gombra kattint. Ezt mondd el neki, és soha ne állítsd, hogy a foglalás már elkészült.
- Személyes adatot (nevet, telefonszámot, e-mail címet) ne kérj a chatben – ezeket az űrlapon kell megadni.
- Az időpontokat budapesti idő szerint értsd. A "ma", "holnap", "szombaton" kifejezéseket a beszélgetés elején megadott dátum alapján értelmezd.

## A Play Padel adatai (tesztadatok)
- Cím: 1117 Budapest, Padel utca 3.
- Telefon: +36 1 234 5678 · E-mail: info@playpadel.hu
- Nyitvatartás: hétfő–péntek 7:00–22:00, szombat–vasárnap 8:00–22:00. Ünnepnapokon a hétvégi nyitvatartás érvényes.
- Pályák: 3 szabványos, 20×10 méteres, üvegfalas padelpálya fedett csarnokban, LED világítással: Piros (1-es), Zöld (2-es), Lila (3-as).
  - Piros: pörgős esti meccsekhez kedvelt. Zöld: első alkalomra és edzésre ideális. Lila: baráti bajnokságok és céges csapatépítők helyszíne.
- Árak (egy pálya, egy óra, a négy játékos között megosztva):
  - Hétköznap 7:00–16:00: 8 000 Ft/óra
  - Hétköznap 16:00–22:00 (csúcsidő): 12 000 Ft/óra
  - Hétvégén egész nap: 10 000 Ft/óra
  - Ütőbérlés: 1 000 Ft/db · Labda (3 db): 2 500 Ft · Kezdő edzés edzővel: előzetes egyeztetéssel, telefonon vagy e-mailben.
- Fizetés: a helyszínen, készpénzzel vagy bankkártyával.
- Lemondás, módosítás: a visszaigazoló e-mailre válaszolva vagy telefonon. A kezdés előtt legalább 24 órával díjmentes.
- Megközelítés:
  - Tömegközlekedéssel: a „Padel utca” villamosmegállótól 3 perc séta.
  - Autóval: ingyenes parkoló 30 autónak a csarnok mellett.
  - Kerékpárral: fedett kerékpártároló a bejáratnál.
- Szolgáltatások: öltözők zuhanyzóval, értékmegőrző szekrények, kis büfé (víz, sportital, kávé, snackek), ingyenes wifi.
- Felszerelés: tiszta talpú, sima vagy halszálkás talpú sportcipő szükséges. Ütő és labda bérelhető.

## A padel szabályai (röviden)
- Mindig párosban, 2 a 2 ellen játsszák, 20×10 m-es, üvegfallal és dróthálóval körbezárt pályán, középen hálóval.
- Adogatás: alulról, az alapvonal mögül; a labdát egyszer le kell pattintani, és derékmagasságban vagy alatta megütni. Átlósan, az ellenfél adogatómezőjébe kell érkeznie. Két próbálkozás jár. Ha az adogatott labda pattanás után a dróthálót éri, hiba; ha az üvegfalat, szabályos. Ha a hálót érinti és jó mezőbe esik, ismétlés.
- A labda a saját térfélen legfeljebb egyszer pattanhat a földön; pattanás után a falról visszajöhet, és úgy is visszaüthető. Röptézni szabad, kivéve az adogatás fogadásakor.
- Az átütött labdának először az ellenfél talaját kell érintenie; ha előbb falat vagy hálót ér, a pont elveszett. A saját fal felhasználható (a labdát a saját falad felé is ütheted).
- Pontot veszít, aki: kétszer pattanni hagyja a labdát; hálóba vagy közvetlenül falba üt; a labdát közvetlenül a pályán kívülre üti; hozzáér a hálóhoz vagy átnyúl; akit a labda eltalál.
- Pontszámítás, mint a teniszben: 15–30–40–játék. 40–40-nél két pont különbséggel lehet nyerni, vagy "arany pont" dönt. 6 nyert játék (2 különbséggel) egy szett, 6–6-nál rövidítés; a meccs általában két nyert szettig tart.
- Történet: 1969-ben Mexikóban született (Enrique Corcuera), Spanyolországban vált igazán népszerűvé.

## Határok
- Csak a Play Padellel, a padellel és a pályafoglalással kapcsolatos kérdésekben segíts. Más témájú kérést udvariasan hárítsd el egy mondatban, és mondd el, miben tudsz segíteni.
- Ha olyasmit kérdeznek a Play Padelről, ami nincs fent leírva, ne találj ki semmit: mondd, hogy erről nincs információd, és ajánld a telefonszámot vagy az e-mail címet.
- Árengedményt, kivételt vagy a fentiektől eltérő ígéretet ne tégy.`;

// ---------------------------------------------------------------------
// Eszközök
// ---------------------------------------------------------------------
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_availability',
    description:
      'Lekérdezi a Play Padel három pályájának szabad idősávjait egy adott napra (budapesti idő). ' +
      'Csak a mai naptól számított ' + DAYS_AHEAD + ' napon belüli dátumra működik. ' +
      'Visszaadja a nyitvatartást és pályánként a szabad idősávokat; a mai napon a már elmúlt időpontok nem szabadok.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'A nap ÉÉÉÉ-HH-NN formátumban, pl. 2026-11-07.' },
      },
      required: ['date'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'prepare_booking',
    description:
      'Kijelöl egy szabad időpontot a weboldal foglalási naptárában, és az űrlaphoz görgeti a látogatót. ' +
      'NEM hozza létre a foglalást – azt a látogató véglegesíti az űrlapon (név, telefon, e-mail, adatkezelési hozzájárulás). ' +
      'Csak akkor hívd, ha a látogató megerősítette a napot, a kezdést, az időtartamot és a pályát, és a get_availability szerint az időpont szabad.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'A nap ÉÉÉÉ-HH-NN formátumban.' },
        court: { type: 'string', enum: ['piros', 'zold', 'lila'], description: 'A pálya azonosítója.' },
        start: { type: 'string', description: 'Kezdés ÓÓ:PP formátumban, egész vagy fél óra, pl. 18:00 vagy 18:30.' },
        duration_minutes: { type: 'integer', enum: [60, 90, 120], description: 'Időtartam percben.' },
      },
      required: ['date', 'court', 'start', 'duration_minutes'],
      additionalProperties: false,
    },
    strict: true,
  },
];

type PrefillAction = { type: 'prefill'; date: string; court: string; start: string; minutes: number };

// ---------------------------------------------------------------------
// Dátum- és időkezelés (budapesti idő)
// ---------------------------------------------------------------------
function budapestNow(): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86_400_000);
}

const isoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z'));
const weekday = (iso: string) => new Intl.DateTimeFormat('hu-HU', { weekday: 'long', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
const isWeekend = (iso: string) => [0, 6].includes(new Date(iso + 'T12:00:00Z').getUTCDay());
const openMin = (iso: string) => (isWeekend(iso) ? 8 * 60 : 7 * 60);
const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const parseHHMM = (s: string) => {
  const m = /^(\d{1,2}):(\d{2})(?::00)?$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

function dateContext(): string {
  const now = budapestNow();
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => {
    const d = addDays(now.date, i);
    return `${d} (${weekday(d)}${i === 0 ? ', ma' : i === 1 ? ', holnap' : ''})`;
  });
  return `<kontextus>A beszélgetés kezdetén Budapesten ${now.date}, ${weekday(now.date)} van, az idő ${fmt(now.minutes)}.\nFoglalható napok: ${days.join('; ')}.</kontextus>`;
}

// ---------------------------------------------------------------------
// Foglaltság a Supabase adatbázisból
// ---------------------------------------------------------------------
type Busy = { court: string; start: number; end: number };

async function fetchBusy(date: string): Promise<Busy[]> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY') || PUBLIC_KEY_FALLBACK;
  const res = await fetch(`${url}/rest/v1/rpc/get_busy_slots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ p_date: date }),
  });
  if (!res.ok) throw new Error(`get_busy_slots hiba (${res.status}): ${await res.text()}`);
  const rows: { court: string; start_time: string; end_time: string }[] = await res.json();
  return rows.map((r) => ({ court: r.court, start: parseHHMM(r.start_time), end: parseHHMM(r.end_time) }));
}

function freeRanges(date: string, busy: Busy[], court: string): string[] {
  const now = budapestNow();
  // A mai napon csak a következő fél órás kezdéstől lehet foglalni
  let from = openMin(date);
  if (date === now.date) from = Math.max(from, Math.floor(now.minutes / 30) * 30 + 30);
  const ranges: string[] = [];
  let cur: number | null = null;
  for (let t = from; t < CLOSE_MIN; t += 30) {
    const taken = busy.some((b) => b.court === court && b.start < t + 30 && t < b.end);
    if (!taken && cur === null) cur = t;
    if (taken && cur !== null) { ranges.push(`${fmt(cur)}–${fmt(t)}`); cur = null; }
  }
  if (cur !== null) ranges.push(`${fmt(cur)}–${fmt(CLOSE_MIN)}`);
  return ranges;
}

function checkDate(date: unknown): string | null {
  if (!isoDate(date)) return 'Érvénytelen dátum, ÉÉÉÉ-HH-NN formátum kell.';
  const diff = daysBetween(budapestNow().date, date);
  if (diff < 0) return 'Ez a nap már elmúlt.';
  if (diff >= DAYS_AHEAD) return `Online csak ${DAYS_AHEAD} napra előre lehet foglalni (az utolsó foglalható nap: ${addDays(budapestNow().date, DAYS_AHEAD - 1)}).`;
  return null;
}

async function runTool(name: string, input: Record<string, unknown>, actions: PrefillAction[]): Promise<{ content: string; isError?: boolean }> {
  if (name === 'get_availability') {
    const err = checkDate(input.date);
    if (err) return { content: err, isError: true };
    const date = input.date as string;
    const busy = await fetchBusy(date);
    const courts = Object.fromEntries(
      Object.entries(COURTS).map(([id, label]) => [id, { nev: label, szabad_idosavok: freeRanges(date, busy, id) }]),
    );
    return {
      content: JSON.stringify({
        datum: date,
        nap: weekday(date),
        nyitvatartas: `${fmt(openMin(date))}–${fmt(CLOSE_MIN)}`,
        palyak: courts,
        megjegyzes: 'Egy idősávon belül bármely egész vagy fél órás kezdés foglalható, ha a teljes időtartam belefér.',
      }),
    };
  }

  if (name === 'prepare_booking') {
    const err = checkDate(input.date);
    if (err) return { content: err, isError: true };
    const date = input.date as string;
    const court = String(input.court);
    const start = parseHHMM(String(input.start));
    const minutes = Number(input.duration_minutes);
    if (!(court in COURTS)) return { content: 'Ismeretlen pálya.', isError: true };
    if (![60, 90, 120].includes(minutes)) return { content: 'Az időtartam 60, 90 vagy 120 perc lehet.', isError: true };
    if (Number.isNaN(start) || start % 30 !== 0) return { content: 'A kezdés csak egész vagy fél óra lehet.', isError: true };
    if (start < openMin(date) || start + minutes > CLOSE_MIN) {
      return { content: `Nyitvatartáson kívül esik (${fmt(openMin(date))}–${fmt(CLOSE_MIN)}).`, isError: true };
    }
    const now = budapestNow();
    if (date === now.date && start <= now.minutes) return { content: 'Ez az időpont ma már elmúlt.', isError: true };
    const busy = await fetchBusy(date);
    if (busy.some((b) => b.court === court && b.start < start + minutes && start < b.end)) {
      return {
        content: JSON.stringify({ hiba: 'Az időpont foglalt.', szabad_idosavok_ezen_a_palyan: freeRanges(date, busy, court) }),
        isError: true,
      };
    }
    actions.push({ type: 'prefill', date, court, start: fmt(start), minutes });
    return {
      content: JSON.stringify({
        ok: true,
        kijelolve: `${COURTS[court]} pálya, ${date} (${weekday(date)}), ${fmt(start)}–${fmt(start + minutes)}`,
        teendo_a_latogatonak: 'Az űrlapon add meg a neved, telefonszámod, e-mail címed, fogadd el az adatkezelési tájékoztatót, majd kattints a „Foglalás elküldése” gombra.',
      }),
    };
  }

  return { content: `Ismeretlen eszköz: ${name}`, isError: true };
}

// ---------------------------------------------------------------------
// Visszaélés elleni védelem: napi üzenetkorlát (adatbázisban, hash-elt IP-vel)
// ---------------------------------------------------------------------
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rateLimitOk(ip: string): Promise<boolean> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('Hiányzik a SUPABASE_URL vagy SUPABASE_SERVICE_ROLE_KEY.');
  const perIp = Number(Deno.env.get('CHAT_DAILY_LIMIT_PER_IP') || 40);
  const total = Number(Deno.env.get('CHAT_DAILY_LIMIT_TOTAL') || 1000);
  // A só a kulcsból származik, így a hash nem visszafejthető egyszerű IP-próbálgatással.
  const ipHash = (await sha256(`${key.slice(-16)}|${ip}`)).slice(0, 32);
  const res = await fetch(`${url}/rest/v1/rpc/chat_rate_hit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ p_key: ipHash, p_limit_key: perIp, p_limit_total: total }),
  });
  if (!res.ok) throw new Error(`chat_rate_hit hiba (${res.status}): ${await res.text()}`);
  return (await res.json()) === true;
}

// ---------------------------------------------------------------------
// Bemenet ellenőrzése
// ---------------------------------------------------------------------
type ChatRequest = { messages: Anthropic.MessageParam[] };

function validate(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !Array.isArray((body as ChatRequest).messages)) return 'Hibás kérés.';
  const msgs = (body as ChatRequest).messages;
  if (msgs.length === 0) return 'Üres beszélgetés.';
  if (msgs.length > MAX_HISTORY_MESSAGES) return 'A beszélgetés túl hosszú – kezdj újat a chat fejlécében.';
  for (const m of msgs) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return 'Hibás üzenet.';
  }
  const last = msgs[msgs.length - 1];
  if (last.role !== 'user' || typeof last.content !== 'string') return 'Hibás üzenet.';
  if (last.content.trim().length === 0) return 'Üres üzenet.';
  if (last.content.length > MAX_USER_CHARS) return `Az üzenet túl hosszú (legfeljebb ${MAX_USER_CHARS} karakter).`;
  return null;
}

// ---------------------------------------------------------------------
// Claude hívás tool-use ciklussal
// ---------------------------------------------------------------------
let client: Anthropic | null = null;

function stripThinking(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam =>
    m.role === 'assistant' && typeof m.content !== 'string'
      ? { role: 'assistant', content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') }
      : m,
  );
}

async function callClaude(messages: Anthropic.MessageParam[]) {
  client ??= new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY'), timeout: 60_000, maxRetries: 1 });
  const params = {
    model: MODEL,
    max_tokens: 8000,
    // Csevegéshez az alacsony effort elég: gyorsabb és olcsóbb válasz.
    output_config: { effort: 'low' as const },
    // Az automatikus gyorsítótárazás a rendszerprompt + eszközök + előzmény prefixét cache-eli.
    cache_control: { type: 'ephemeral' as const },
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
    betas: ['server-side-fallback-2026-07-01'],
    // Ha a modell biztonsági okból elutasítaná a kérést, a szerver egy ajánlott tartalék modellen futtatja újra.
    fallbacks: 'default',
  };
  // A `fallbacks: "default"` formát az SDK típusai még nem feltétlenül ismerik.
  // deno-lint-ignore no-explicit-any
  return await client.beta.messages.create(params as any) as Anthropic.Beta.BetaMessage;
}

async function chat(history: Anthropic.MessageParam[]): Promise<{ messages: Anthropic.MessageParam[]; reply: string; actions: PrefillAction[] }> {
  const messages = [...history];

  // Az első üzenethez hozzáfűzzük a dátum-kontextust. Mivel ez a böngészőben tárolt előzmény
  // része marad, a beszélgetés eleje (prefix) később sem változik – a gondolkodási blokkok és a
  // gyorsítótár így érvényesek maradnak.
  if (messages.length === 1 && typeof messages[0].content === 'string') {
    messages[0] = { role: 'user', content: [{ type: 'text', text: dateContext() }, { type: 'text', text: messages[0].content }] };
  }

  const actions: PrefillAction[] = [];
  let stripped = false;

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await callClaude(stripped ? stripThinking(messages) : messages);
    } catch (e) {
      // Ha a böngészőből érkezett előzményben érvénytelen gondolkodási blokk van, egyszer
      // újrapróbáljuk nélkülük (a szöveg és az eszközhívások megmaradnak).
      if (!stripped && e instanceof Anthropic.BadRequestError && /thinking/i.test(e.message)) {
        console.warn('[chatbot] érvénytelen thinking blokk – újrapróba nélkülük');
        stripped = true;
        round--;
        continue;
      }
      throw e;
    }
    if (stripped) {
      messages.splice(0, messages.length, ...stripThinking(messages));
      stripped = false;
    }

    console.log(`[chatbot] kör ${round}: stop=${response.stop_reason} in=${response.usage.input_tokens} cache_read=${response.usage.cache_read_input_tokens ?? 0} out=${response.usage.output_tokens}`);

    if (response.stop_reason === 'refusal') {
      return { messages: history, reply: 'Ebben sajnos nem tudok segíteni. Kérdezz bátran a foglalásról, a padel szabályairól vagy a Play Padelről!', actions: [] };
    }

    messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });

    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason !== 'tool_use') {
      const reply = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { messages, reply: reply || 'Elnézést, most nem sikerült válaszolnom. Megpróbálnád újra?', actions };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result: { content: string; isError?: boolean };
      try {
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
        result = await runTool(block.name, input, actions);
      } catch (e) {
        console.error('[chatbot] eszközhiba:', e);
        result = { content: 'A foglalási rendszer most nem elérhető, próbáld újra később.', isError: true };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.content, ...(result.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, reply: 'Ez most túl bonyolult lett nekem – megpróbálnád egyszerűbben megfogalmazni?', actions };
}

// ---------------------------------------------------------------------
// HTTP belépési pont (CORS-szal)
// ---------------------------------------------------------------------
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = (Deno.env.get('CHAT_ALLOWED_ORIGINS')?.split(',').map((s) => s.trim()).filter(Boolean)) ?? DEFAULT_ORIGINS;
  const ok = origin && allowed.includes(origin);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin! } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status: number, data: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'Csak POST kérés engedélyezett.' }, cors);
  if (!cors['Access-Control-Allow-Origin']) return json(403, { error: 'Nem engedélyezett weboldal.' }, cors);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'A beszélgetés túl hosszú – kezdj újat.' }, cors);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'Hibás kérés.' }, cors); }
  const problem = validate(body);
  if (problem) return json(400, { error: problem }, cors);

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'ismeretlen';
  try {
    if (!(await rateLimitOk(ip))) {
      return json(429, { error: 'Mára elérted a chat üzenetkorlátját. Foglalni a naptárban, kérdezni telefonon (+36 1 234 5678) is tudsz.' }, cors);
    }
  } catch (e) {
    console.error('[chatbot] korlátozás ellenőrzése sikertelen:', e);
    return json(503, { error: 'A chat jelenleg nem elérhető.' }, cors);
  }

  try {
    const result = await chat((body as ChatRequest).messages);
    return json(200, result, cors);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      console.error('[chatbot] Claude API rate limit:', e.message);
      return json(503, { error: 'Most sokan kérdeznek – próbáld újra egy perc múlva.' }, cors);
    }
    if (e instanceof Anthropic.AuthenticationError) {
      console.error('[chatbot] Hibás vagy hiányzó ANTHROPIC_API_KEY');
      return json(503, { error: 'A chat jelenleg nem elérhető.' }, cors);
    }
    if (e instanceof Anthropic.APIError) {
      console.error(`[chatbot] Claude API hiba ${e.status}:`, e.message);
      return json(502, { error: 'Hiba történt, próbáld újra.' }, cors);
    }
    console.error('[chatbot] váratlan hiba:', e);
    return json(500, { error: 'Hiba történt, próbáld újra.' }, cors);
  }
});
