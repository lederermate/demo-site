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

## Helyi futtatás

```bash
python3 -m http.server 8000
```

majd: http://localhost:8000

## Megjegyzés

A cím, telefonszám, e-mail, nyitvatartás és árak minta adatok – élesítés előtt cserélendők.
Az adatkezelési tájékoztató sablon: élesítés előtt a kiemelt adatokat ki kell tölteni, és
javasolt jogi szakemberrel átnézetni.
