// Integritetsinformation: vilka personuppgifter som behandlas, varför och hur
// länge. Publik, så att föräldrar och deltagare kan läsa den utan konto.
// Arrangören kan ersätta texten under Inställningar; lagringstiderna hämtas
// alltid från samma inställning som gallringen använder.
import type { Metadata } from 'next';
import { createClient } from '@/lib/supabase/server';
import { RETENTION } from '@/lib/gdpr';
import MyDataButton from '@/components/privacy/MyDataButton';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Integritetsinformation' };

type Info = { name?: string; text?: string; ends_on?: string | null; retention?: Record<string, number> };

function custom(text: string) {
  return text.split(/\n{2,}/).map((block, i) =>
    block.startsWith('# ')
      ? <h2 key={i}>{block.slice(2).trim()}</h2>
      : <p key={i}>{block.trim()}</p>
  );
}

export default async function PrivacyPage() {
  const supabase = await createClient();
  const [{ data }, { data: { user } }] = await Promise.all([
    supabase.rpc('privacy_info').then((r) => r, () => ({ data: null })),
    supabase.auth.getUser()
  ]);
  const info = (data ?? {}) as Info;
  const name = info.name || 'Turneringen';
  const days = (key: string, fallback: number) => Number(info.retention?.[key] ?? fallback);
  const until = (n: number) => {
    if (!info.ends_on) return '';
    const d = new Date(`${info.ends_on}T12:00:00`);
    d.setDate(d.getDate() + n);
    return ` (${d.toLocaleDateString('sv-SE')})`;
  };
  const text = (info.text ?? '').trim();

  return (
    <div className="privacy-wrap">
      <article className="privacy-card">
        <div className="login-eyebrow">INTEGRITETSINFORMATION</div>
        <h1>{name}</h1>

        {text ? custom(text) : (
          <>
            <p>{name} använder Work Cup för att planera och genomföra turneringen. Här står vilka personuppgifter som behandlas, varför och hur länge de sparas.</p>

            <h2>Vem som ansvarar</h2>
            <p>Arrangören av {name} är personuppgiftsansvarig. Aetos Systems levererar systemet och behandlar uppgifterna bara på arrangörens uppdrag, som personuppgiftsbiträde.</p>

            <h2>Vilka uppgifter</h2>
            <ul>
              <li><b>Personal och funktionärer:</b> namn, e-post, telefonnummer, roll, arbetspass, var man arbetar, meddelanden i appen och det man rapporterar, till exempel incidenter och felanmälningar.</li>
              <li><b>Lag:</b> lagnamn, förening, åldersklass, antal personer, boende samt lagledarens namn och telefonnummer.</li>
              <li><b>Deltagare:</b> namn, födelseår, lag, roll och tröjnummer. Hela födelsedatum och personnummer sparas aldrig.</li>
            </ul>
            <p>Inga hälsouppgifter, allergier eller uppgifter om anhöriga sparas i systemet.</p>

            <h2>Varför</h2>
            <p>För att turneringen ska gå säkert och smidigt: veta vilka som bor var, särskilt nattetid, och för måltider, transporter, matcher och kommunikation mellan funktionärer. Uppgifterna används inte för marknadsföring och säljs inte.</p>

            <h2>Till föräldrar och vårdnadshavare</h2>
            <p>Många deltagare är under 18 år. Därför sparas så lite som möjligt om dem: namn, födelseår och lag. Uppgifterna syns bara för funktionärer som arbetar med laget eller boendet, och de raderas automatiskt efter turneringen. Vill ni veta vad som finns sparat om ert barn, rätta något eller få uppgifterna raderade, kontakta lagledaren eller arrangören.</p>

            <h2>Hur länge</h2>
            <p>Uppgifterna raderas automatiskt när tiden nedan har gått, räknat från turneringens sista dag.</p>
            <ul>
              {RETENTION.map((r) => (
                <li key={r.key}><b>{r.label}:</b> {days(r.key, r.days)} dagar{until(days(r.key, r.days))}</li>
              ))}
            </ul>

            <h2>Dina rättigheter</h2>
            <p>Du har rätt att få veta vilka uppgifter som finns om dig (registerutdrag), att få fel rättade, att få uppgifter raderade och att invända mot behandlingen. Kontakta arrangören av {name}. Du kan också lämna klagomål till Integritetsskyddsmyndigheten (IMY).</p>

            <h2>In English</h2>
            <p>{name} uses Work Cup to run the tournament. The organiser is the data controller; Aetos Systems processes data on the organiser&apos;s behalf. We store names and contact details of staff and team leaders, and for participants only name, year of birth, team, role and shirt number. No health data is stored. Data is deleted automatically after the tournament according to the periods above. Contact the organiser to access, correct or delete data.</p>
          </>
        )}

        {user && (
          <div className="privacy-mine">
            <h2>Dina egna uppgifter</h2>
            <p>Du är inloggad och kan ladda ner allt systemet har om dig.</p>
            <MyDataButton userId={user.id} />
          </div>
        )}

        <p className="li-meta" style={{ marginTop: 24 }}><a href="/dashboard">Till appen</a></p>
      </article>
    </div>
  );
}
