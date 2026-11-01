// Play Padel – foglalási háttér beállításai.
//
// Üresen hagyva az oldal DEMÓ módban fut: minta foglaltságot mutat, az új
// foglalások pedig csak a látogató saját böngészőjében tárolódnak.
//
// Élesítéshez (Supabase): Project Settings → API Keys
//   supabaseUrl: a projekt URL-je, pl. https://abcd1234.supabase.co
//   supabaseKey: a "publishable" (sb_publishable_...) vagy a régi "anon" kulcs.
// Ezek a kulcsok nyilvánosak, a böngészőbe szánták őket – a védelmet az
// adatbázis jogosultságai adják (lásd supabase/schema.sql).
// A "secret" / "service_role" kulcsot SOHA ne írd ide!
window.PLAY_PADEL_CONFIG = {
  supabaseUrl: 'https://mvxakuksgydasbnyyfzf.supabase.co',
  supabaseKey: 'sb_publishable_LcPN3pjPTcc9XulNSSvdig_Qlb6saFR',
};
