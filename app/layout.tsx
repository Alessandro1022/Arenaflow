import type { Metadata, Viewport } from 'next';
import { tenant } from '@/lib/tenant';
import { LanguageProvider } from '@/components/LanguageProvider';
import TenantProvider from '@/components/TenantProvider';
import SwRegister from '@/components/SwRegister';
import './globals.css';

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
    statusBarStyle: 'black-translucent'
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
        <TenantProvider>
          <LanguageProvider>{children}</LanguageProvider>
        </TenantProvider>
        <SwRegister enabled={swEnabled} />
      </body>
    </html>
  );
}
