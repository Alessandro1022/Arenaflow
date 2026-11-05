import type { Metadata, Viewport } from 'next';
import { tenant } from '@/lib/tenant';
import { LanguageProvider } from '@/components/LanguageProvider';
import TenantProvider from '@/components/TenantProvider';
import SwRegister from '@/components/SwRegister';
import BootSplash from '@/components/BootSplash';
import './globals.css';

// Startbilder när appen öppnas från hemskärmen på iPhone, en per skärmstorlek.
// Visas i stället för en vit skärm tills första sidan ritats (public/splash).
const STARTUP_IMAGES = [
  { url: '/splash/1320x2868.png', media: '(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1206x2622.png', media: '(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1260x2736.png', media: '(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1290x2796.png', media: '(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1179x2556.png', media: '(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1284x2778.png', media: '(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1170x2532.png', media: '(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1125x2436.png', media: '(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/1242x2688.png', media: '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/828x1792.png', media: '(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' },
  { url: '/splash/1242x2208.png', media: '(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)' },
  { url: '/splash/750x1334.png', media: '(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)' }
];

export const metadata: Metadata = {
  title: `${tenant.event.name} · TournamentOps`,
  description: 'Drift- och personalsystem',
  manifest: '/manifest.json',
  icons: {
    icon: [
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  },
  appleWebApp: {
    capable: true,
    title: tenant.event.name,
    statusBarStyle: 'black-translucent',
    startupImage: STARTUP_IMAGES
  }
};

export const viewport: Viewport = {
  // Topbarens färg, så statusfältet smälter in i stället för att bli vitt
  themeColor: tenant.theme.panel2,
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const t = tenant.theme;
  const vars = {
    '--bg': t.bg, '--panel': t.panel, '--panel-2': t.panel2, '--line': t.line,
    '--ink': t.ink, '--muted': t.muted,
    '--sidebar-ink': t.sidebarInk, '--sidebar-muted': t.sidebarMuted,
    '--primary': t.primary, '--primary-dark': t.primaryDark,
    '--accent': t.accent, '--danger': t.danger, '--ok': t.ok
  } as React.CSSProperties;

  // Offline-workern kan stängas av för alla med OFFLINE_SW=off i Vercel
  // (kräver Redeploy). /offline-sw.js läser samma variabel.
  const swEnabled = process.env.OFFLINE_SW !== 'off';

  // Räddningslucka: körs före alla bundles, så den fungerar även när en gammal
  // service worker har låst sidladdningen. Tar bort allt som inte är den
  // nuvarande offline-workern (/offline-sw.js), eller allt om offline är
  // avstängt. Laddar om bara när sidan styrdes av en gammal worker – efter
  // omladdningen finns ingen sådan kvar, så den kan inte loopa.
  const swReset = `(function(){try{
if(!('serviceWorker' in navigator))return;
var off=${swEnabled ? 'false' : 'true'};
try{if(/[?&]sw=off(&|$)/.test(location.search)||localStorage.getItem('tops-sw-off')==='1')off=true}catch(e){}
var ours=function(u){try{return new URL(u).pathname==='/offline-sw.js'}catch(e){return false}};
var c=navigator.serviceWorker.controller;
var oldCtl=!!c&&!ours(c.scriptURL);
navigator.serviceWorker.getRegistrations().then(function(rs){
return Promise.all(rs.filter(function(r){var w=r.active||r.waiting||r.installing;return off||!w||!ours(w.scriptURL)})
.map(function(r){return r.unregister()}));
}).then(function(){
return window.caches?caches.keys().then(function(ks){
return Promise.all(ks.filter(function(k){return off||k.indexOf('tops-offline-')!==0}).map(function(k){return caches.delete(k)}))}):null
}).then(function(){if(oldCtl)location.reload()}).catch(function(){})
}catch(e){}})();`;

  return (
    <html lang="sv" style={vars}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: swReset }} />
      </head>
      <body>
        {/* Laddningsruta i den servrade HTML:en, så något syns direkt när appen öppnas
            från hemskärmen. Tas bort av BootSplash när React startat, och döljs av
            CSS efter 12 s om något fastnar. Ingen JavaScript krävs för att den ska synas. */}
        <div
          id="boot-splash"
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
            background: t.panel2, color: t.ink,
            animation: 'boot-out 0.3s ease 12s forwards'
          }}
        >
          <style>{`@keyframes boot-out{to{opacity:0;visibility:hidden}}@keyframes boot-spin{to{transform:rotate(360deg)}}`}</style>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon-192.png" alt="" width={72} height={72} style={{ borderRadius: 16 }} />
          <div style={{ fontWeight: 600, fontSize: 16 }}>{tenant.event.name}</div>
          <div
            aria-label="Laddar"
            style={{
              width: 28, height: 28, borderRadius: '50%',
              border: `3px solid ${t.line}`, borderTopColor: t.primary,
              animation: 'boot-spin 0.9s linear infinite'
            }}
          />
        </div>
        <BootSplash />
        <TenantProvider>
          <LanguageProvider>{children}</LanguageProvider>
        </TenantProvider>
        <SwRegister enabled={swEnabled} />
      </body>
    </html>
  );
}
