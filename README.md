# Play Padel – weboldal

Statikus weboldal (HTML + CSS + JS) a budapesti Play Padel számára, három pályával
(piros, zöld, lila). GitHub Pages-en publikálva: https://lederermate.github.io/demo-site/

## Tartalom

- Pályák bemutatása, galéria (3D látványtervek az `images/` mappában)
- A padelről, működés, szabályok, árak, kapcsolat
- **Foglaltsági naptár + foglalás** (Supabase adatbázissal vagy demó módban)

## Fájlok

| Fájl | Mire való |
| --- | --- |
| `index.html`, `style.css`, `script.js` | az oldal |
| `booking.js` | foglaltsági naptár és foglalás |
| `config.js` | Supabase elérés (üresen = demó mód) |
| `supabase/schema.sql` | adatbázis séma, ütközésvédelem, jogosultságok, automatikus adattörlés |
| `supabase/functions/foglalas-ertesito/index.ts` | Edge Function: Google Naptár szinkron + visszaigazoló / értesítő e-mailek |
| `adatvedelem.html` | adatkezelési tájékoztató (a kiemelt céges adatok kitöltendők) |
| `fonts/` | saját tárhelyről kiszolgált betűtípusok (Inter, Archivo – SIL OFL) |

## Foglalási rendszer beüzemelése (Supabase)

1. Regisztrálj / lépj be: https://supabase.com → **New project**
   (régió: *Central EU (Frankfurt)*, az ingyenes csomag elég).
2. **SQL Editor → New query**: másold be a `supabase/schema.sql` tartalmát → **Run**.
3. **Project Settings → API Keys**: másold ki a projekt URL-t és a
   **publishable** (vagy régi *anon*) kulcsot.
4. Írd be őket a `config.js`-be, majd push → pár perc múlva élesben működik.

> A publishable/anon kulcs nyilvános, böngészőbe szánt kulcs. A **secret /
> service_role** kulcsot soha ne tedd a weboldalba!

### Hogyan véd az adatbázis?

- **Ütközés:** egy `EXCLUDE` megkötés garantálja, hogy egy pályára egy időben
  csak egy érvényes foglalás létezhet – akkor is, ha ketten egyszerre kattintanak.
- **Adatvédelem:** a `bookings` tábla a böngészőből nem olvasható és nem írható.
  Az oldal csak két függvényt hívhat:
  - `get_busy_slots(dátum)` – csak pálya + időpont, név/telefonszám nélkül
  - `create_booking(...)` – ellenőrzi a nyitvatartást, a fél órás kezdést,
    az időtartamot (1 / 1,5 / 2 óra), hogy a jövőbe essen (max. 60 nap), és
    telefonszámonként legfeljebb 3 aktív foglalást enged.
- **Adatkezelési tájékoztató:** foglalni csak a jelölőnégyzet bepipálásával lehet;
  az elfogadott verzió és időpont foglalásonként rögzül (`privacy_version`,
  `privacy_accepted_at`). Ha a tájékoztató változik, a `booking.js`-ben a
  `PRIVACY_VERSION`-t és az `adatvedelem.html` verzióját is frissíteni kell.
- **Adatmegőrzés:** a lejárt foglalások 90 nap után automatikusan törlődnek
  (pg_cron, `playpadel-adattorles` feladat – Supabase → Integrations → Cron).
- **Lemondás:** a Supabase *Table Editorban* a foglalás `status` mezőjét
  `cancelled`-re állítva az időpont azonnal újra szabad lesz.

## Google Naptár szinkron és e-mail értesítések

Minden új foglalás néhány másodpercen belül esemény lesz a Google Naptárban (pályánként
más színnel), a foglaló visszaigazoló e-mailt kap, a tulajdonos pedig értesítést.
Lemondáskor (`status` → `cancelled`) az esemény törlődik, és lemondó e-mail megy ki;
a foglalás törlésekor (kézzel vagy a 90 napos automatikus törléssel) az esemény is törlődik.

```
foglalás (weboldal) → Supabase bookings tábla → Database Webhook → Edge Function
                                                                  ├─ Google Calendar API (szolgáltatásfiók)
                                                                  └─ Gmail SMTP (alkalmazásjelszó)
```

### 1. Google Naptár – szolgáltatásfiók

1. https://console.cloud.google.com → új projekt (pl. `playpadel`).
2. **APIs & Services → Library** → *Google Calendar API* → **Enable**.
3. **IAM & Admin → Service Accounts → Create service account** (pl. `playpadel-naptar`), szerepkör nem kell.
4. A fiók → **Keys → Add key → Create new key → JSON** → letöltődik egy `.json` fájl.
5. https://calendar.google.com → *Egyéb naptárak* **+** → **Új naptár** (pl. „Play Padel foglalások”).
6. Az új naptár beállításai → **Megosztás adott személyekkel** → a szolgáltatásfiók e-mail címe
   (`…@….iam.gserviceaccount.com`) → jogosultság: **Módosíthatja az eseményeket**.
7. Ugyanitt, **Naptár integrálása** → másold ki a **Naptárazonosítót** (`…@group.calendar.google.com`).

### 2. Gmail – alkalmazásjelszó

1. A küldő Google-fiókban kapcsold be a **kétlépcsős azonosítást**.
2. https://myaccount.google.com/apppasswords → név: `Play Padel` → a kapott 16 karakteres jelszót másold ki.

### 3. Supabase – Edge Function

1. **Edge Functions → Deploy a new function → Via Editor**, név: `foglalas-ertesito`,
   tartalom: `supabase/functions/foglalas-ertesito/index.ts` → **Deploy**.
2. A függvény beállításainál kapcsold **ki** a JWT ellenőrzést (*Enforce JWT verification*) → Save.
   (A hívásokat a `WEBHOOK_SECRET` védi.)
3. **Edge Functions → Secrets** – vedd fel:

   | Név | Érték |
   | --- | --- |
   | `WEBHOOK_SECRET` | hosszú véletlen szöveg |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | a letöltött JSON fájl teljes tartalma |
   | `GOOGLE_CALENDAR_ID` | a naptárazonosító |
   | `GMAIL_USER` | a küldő Gmail cím |
   | `GMAIL_APP_PASSWORD` | az alkalmazásjelszó |
   | `OWNER_EMAIL` | ide kérsz értesítést az új foglalásokról |

### 4. Supabase – Database Webhook

**Database → Webhooks → Create a new hook**:
név `foglalas-ertesito`, tábla `bookings`, események **Insert, Update, Delete**,
típus **Supabase Edge Functions**, függvény `foglalas-ertesito`, metódus POST,
HTTP header: `x-webhook-secret` = a `WEBHOOK_SECRET` értéke → **Create webhook**.

Hibakeresés: **Edge Functions → foglalas-ertesito → Logs** – minden lépésről
`OK: …` vagy `HIBA: …` sor jelenik meg.

## Helyi futtatás

```bash
python3 -m http.server 8000
```

majd: http://localhost:8000

## Megjegyzés

A cím, telefonszám, e-mail, nyitvatartás és árak minta adatok – élesítés előtt cserélendők.
Az adatkezelési tájékoztató sablon: élesítés előtt a kiemelt adatokat ki kell tölteni, és
javasolt jogi szakemberrel átnézetni.
