'use client';
// Lägesbild på riktig karta. Boenden och spelplatser som markörer på
// OpenStreetMap: färgen säger läget (grönt/blått = lugnt, gult = öppet fel,
// rött = öppen incident), formen säger vad platsen är.
//
// Tryck på en markör för kontakt, nödinfo, vägbeskrivning och ring-knapp.
// Platser utan koordinat placeras genom att trycka på kartan eller via
// adressökning. Bara administratörer får ändra positioner (samma regel
// som databasen har för schools och arenas).
//
// Leaflet laddas först i webbläsaren: biblioteket rör window direkt när
// det läses in och skulle annars krascha serverrenderingen.
import 'leaflet/dist/leaflet.css';
import type * as Leaflet from 'leaflet';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  LocateFixed, Maximize2, Navigation, Phone, X, MapPin, Search, Move, Crosshair, ShieldAlert
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useTenant } from '@/components/TenantProvider';
import {
  KIND_LABEL, SEVERITY_LABEL, STATUS_RANK, corePoints, directionsHref, distanceM, escapeHtml,
  fmtDistance, geocodeQuery, isIOS, markerHtml, markerSignature, searchBox, statusOf, telHref,
  validCoord, type AccKind, type Inc, type Place, type Severity
} from '@/lib/map';

type LeafletNS = typeof Leaflet;
type Row = Record<string, unknown>;
type Filter = 'all' | 'boende' | 'hotell' | 'arena' | 'problem';
type Me = { lat: number; lng: number; acc: number };
type Edit = {
  key: string; mode: 'place' | 'move';
  lat: number | null; lng: number | null;
  note: string; busy: boolean;
};
type Bulk = {
  total: number; done: number; found: number;
  running: boolean; notFound: string[]; error: string;
};
type Hit = { lat: number; lng: number; label: string };

// Kartbilderna kan bytas utan kodändring om turneringen växer ur
// OpenStreetMaps gratisservrar (sätt miljövariablerna i Vercel).
const TILE_URL = process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION ||
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const FALLBACK_CENTER: [number, number] = [57.7089, 11.9746]; // Göteborg
const KINDS: AccKind[] = ['skola', 'hotell', 'vandrarhem', 'camping'];
const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];
const LIST_STEP = 40;

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (v: unknown) => (typeof v === 'string' && v ? v : null);

export default function MapClient({ canEdit, focus }: { canEdit: boolean; focus: string | null }) {
  const tn = useTenant();
  const supabase = useMemo(() => createClient(), []);

  // Leaflet lever utanför React; refs håller instanserna mellan renderingar
  const wrapRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const LRef = useRef<LeafletNS | null>(null);
  const mapRef = useRef<Leaflet.Map | null>(null);
  const layerRef = useRef<Leaflet.LayerGroup | null>(null);
  const markersRef = useRef(new Map<string, { m: Leaflet.Marker; sig: string }>());
  const meLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const medLayerRef = useRef<Leaflet.LayerGroup | null>(null);
  const draftRef = useRef<Leaflet.Marker | null>(null);
  const watchRef = useRef<number | null>(null);
  const meCenteredRef = useRef(false);
  const fittedRef = useRef(false);
  const cityTriedRef = useRef(false);
  const focusDoneRef = useRef(false);
  const stopBulkRef = useRef(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [ready, setReady] = useState(false);
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [tilesDown, setTilesDown] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [listMax, setListMax] = useState(LIST_STEP);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [focusReq, setFocusReq] = useState<{ key: string; zoomIn: boolean; n: number } | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [locating, setLocating] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [ios, setIos] = useState(false);
  // Sjukvårdsstationer, första hjälpen och hjärtstartare (del 26)
  const [med, setMed] = useState<Row[]>([]);
  const [showMed, setShowMed] = useState(true);

  useEffect(() => { setIos(isIOS()); }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2600);
  }, []);

  // ---------- Data ----------
  const load = useCallback(async () => {
    const [sc, ar, st, inc, iss, ars] = await Promise.all([
      // select('*') med flit: kolumner från senare delar (nödinfo, kontakt)
      // finns kanske inte än, och då ska kartan ändå fungera.
      supabase.from('schools').select('*'),
      supabase.from('arenas').select('*'),
      supabase.from('school_stats').select('id,in_house,teams_in,teams_expected'),
      supabase.from('incidents')
        .select('id,title,severity,location_type,location_id,created_at')
        .neq('status', 'resolved')
        .order('created_at', { ascending: false }),
      supabase.from('room_issues').select('school_id').neq('status', 'resolved'),
      supabase.from('areas').select('id,name')
    ]);

    // Sjukvården finns kanske inte än (del 26) – då blir lagret bara tomt
    const mp = await supabase.from('medical_points').select('*');
    setMed(mp.error ? [] : ((mp.data ?? []) as Row[]).filter((m) => num(m.lat) !== null && num(m.lng) !== null));

    const firstErr = sc.error ?? ar.error;
    setLoadErr(firstErr ? `Kunde inte läsa platserna: ${firstErr.message}` : '');

    const areaName = new Map<string, string>(
      ((ars.data ?? []) as Row[]).map((a) => [str(a.id), str(a.name)])
    );
    const stats = new Map<string, Row>(((st.data ?? []) as Row[]).map((s) => [str(s.id), s]));

    const incBy = new Map<string, Inc[]>();
    for (const i of (inc.data ?? []) as Row[]) {
      const lt = str(i.location_type), lid = str(i.location_id);
      if (!lt || !lid) continue;
      const k = `${lt}:${lid}`;
      const sev = (SEVERITIES.includes(i.severity as Severity) ? i.severity : 'medium') as Severity;
      const list = incBy.get(k) ?? [];
      list.push({ id: str(i.id), title: str(i.title) || 'Incident', severity: sev, created_at: str(i.created_at) });
      incBy.set(k, list);
    }
    const issuesBy = new Map<string, number>();
    for (const r of (iss.data ?? []) as Row[]) {
      const sid = str(r.school_id);
      issuesBy.set(sid, (issuesBy.get(sid) ?? 0) + 1);
    }

    const rows: Place[] = [];
    for (const s of (sc.data ?? []) as Row[]) {
      const id = str(s.id);
      const c = validCoord(s.lat, s.lng);
      const flagged = s.coord_flagged === true;
      const stat = stats.get(id);
      const areaId = idOf(s.area_id);
      rows.push({
        key: `school:${id}`, id, type: 'school', name: str(s.name) || 'Namnlöst boende',
        lat: flagged ? null : c?.[0] ?? null, lng: flagged ? null : c?.[1] ?? null,
        flagged, hasFlagColumn: 'coord_flagged' in s, raw: str(s.coord_raw),
        kind: KINDS.includes(s.kind as AccKind) ? (s.kind as AccKind) : 'skola',
        areaId, area: areaId ? areaName.get(areaId) ?? '' : '',
        address: str(s.address), contactName: str(s.contact_name), contactPhone: str(s.contact_phone),
        assembly: str(s.assembly_point), care: str(s.nearest_care), emergency: str(s.emergency_note),
        club: '', capacity: num(s.capacity), surfaces: null,
        inHouse: Number(stat?.in_house ?? 0) || 0,
        teamsIn: Number(stat?.teams_in ?? 0) || 0,
        teamsExpected: Number(stat?.teams_expected ?? 0) || 0,
        incidents: incBy.get(`school:${id}`) ?? [], issues: issuesBy.get(id) ?? 0
      });
    }
    for (const a of (ar.data ?? []) as Row[]) {
      const id = str(a.id);
      const c = validCoord(a.lat, a.lng);
      const areaId = idOf(a.area_id);
      rows.push({
        key: `arena:${id}`, id, type: 'arena', name: str(a.name) || 'Namnlös spelplats',
        lat: c?.[0] ?? null, lng: c?.[1] ?? null,
        flagged: false, hasFlagColumn: false, raw: '',
        kind: null, areaId, area: areaId ? areaName.get(areaId) ?? '' : '',
        address: str(a.address), contactName: str(a.contact_name), contactPhone: str(a.contact_phone),
        assembly: str(a.assembly_point), care: str(a.nearest_care), emergency: str(a.emergency_note),
        club: str(a.club), capacity: null, surfaces: num(a.surface_count),
        inHouse: 0, teamsIn: 0, teamsExpected: 0,
        incidents: incBy.get(`arena:${id}`) ?? [], issues: 0
      });
    }
    setPlaces(rows);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    load();
    const soon = () => {
      clearTimeout(reloadTimer.current);
      reloadTimer.current = setTimeout(load, 600);
    };
    const ch = supabase.channel('map-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'incidents' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'room_issues' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schools' }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'arenas' }, soon)
      .subscribe();
    return () => {
      clearTimeout(reloadTimer.current);
      supabase.removeChannel(ch);
    };
  }, [load, supabase]);

  // ---------- Urval ----------
  const isPlaced = (p: Place) => p.lat !== null && p.lng !== null;

  const matches = useCallback((p: Place, f: Filter) => {
    switch (f) {
      case 'boende': return p.type === 'school';
      case 'hotell': return p.type === 'school' && p.kind === 'hotell';
      case 'arena': return p.type === 'arena';
      case 'problem': return statusOf(p) !== 'ok';
      default: return true;
    }
  }, []);

  const counts = useMemo(() => ({
    all: places.length,
    boende: places.filter((p) => matches(p, 'boende')).length,
    hotell: places.filter((p) => matches(p, 'hotell')).length,
    arena: places.filter((p) => matches(p, 'arena')).length,
    problem: places.filter((p) => matches(p, 'problem')).length
  }), [places, matches]);

  const placed = useMemo(() => places.filter(isPlaced), [places]);
  const missing = useMemo(() => places.filter((p) => !isPlaced(p)), [places]);

  const visible = useMemo(
    () => placed.filter((p) => matches(p, filter)),
    [placed, filter, matches]
  );

  // Platsen som redigeras ritas som nål i stället för markör
  const markerPlaces = useMemo(
    () => visible.filter((p) => p.key !== edit?.key),
    [visible, edit?.key]
  );

  const needle = q.trim().toLowerCase();
  const textMatch = useCallback((p: Place) => !needle ||
    [p.name, p.address, p.area, p.club, p.contactName].some((t) => t.toLowerCase().includes(needle)),
  [needle]);

  const listRows = useMemo(() => {
    const rows = visible.filter(textMatch);
    if (me) {
      const here: [number, number] = [me.lat, me.lng];
      return rows
        .map((p) => ({ p, d: distanceM(here, [p.lat as number, p.lng as number]) }))
        .sort((a, b) => a.d - b.d)
        .map((x) => x.p);
    }
    return rows.sort((a, b) =>
      STATUS_RANK[statusOf(b)] - STATUS_RANK[statusOf(a)] || a.name.localeCompare(b.name, 'sv'));
  }, [visible, textMatch, me]);

  const missingRows = useMemo(
    () => missing.filter((p) => matches(p, filter) && textMatch(p))
      .sort((a, b) => a.name.localeCompare(b.name, 'sv')),
    [missing, filter, matches, textMatch]
  );

  const sel = selKey ? places.find((p) => p.key === selKey) ?? null : null;
  const editPlace = edit ? places.find((p) => p.key === edit.key) ?? null : null;

  const kindLabel = (p: Place) =>
    p.type === 'arena' ? tn.labels.playingArea : KIND_LABEL[p.kind ?? 'skola'];

  // ---------- Kartan ----------
  // Senaste versionen av klickhanterarna, så att Leaflets lyssnare (som
  // registreras en gång) alltid ser aktuellt läge.
  const onMapClick = useRef<(lat: number, lng: number) => void>(() => {});
  const onMarkerClick = useRef<(key: string) => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let map: Leaflet.Map | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      const mod = await import('leaflet');
      const L = ((mod as unknown as { default?: LeafletNS }).default ?? mod) as LeafletNS;
      if (cancelled || !boxRef.current) return;
      LRef.current = L;

      map = L.map(boxRef.current, {
        zoomControl: false,
        attributionControl: true,
        minZoom: 4,
        maxZoom: 19,
        zoomSnap: 0.5,
        tapTolerance: 20
      }).setView(FALLBACK_CENTER, 12);

      map.attributionControl.setPrefix(false);
      L.control.zoom({ position: 'topright', zoomInTitle: 'Zooma in', zoomOutTitle: 'Zooma ut' }).addTo(map);

      let tilesOk = 0, tilesBad = 0;
      L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTR })
        .on('tileload', () => { tilesOk++; setTilesDown(false); })
        .on('tileerror', () => { tilesBad++; if (tilesOk === 0 && tilesBad >= 4) setTilesDown(true); })
        .addTo(map);

      layerRef.current = L.layerGroup().addTo(map);
      medLayerRef.current = L.layerGroup().addTo(map);
      meLayerRef.current = L.layerGroup().addTo(map);

      const zoomClass = () => {
        if (!map) return;
        const z = map.getZoom();
        const el = map.getContainer();
        el.classList.toggle('z-far', z < 12.5);
        el.classList.toggle('z-near', z >= 15);
      };
      map.on('zoomend', zoomClass);
      zoomClass();

      map.on('click', (e: Leaflet.LeafletMouseEvent) => onMapClick.current(e.latlng.lat, e.latlng.lng));

      // Kartan måste få veta när dess låda byter storlek (rotation, meny)
      if (typeof ResizeObserver !== 'undefined' && wrapRef.current) {
        ro = new ResizeObserver(() => map?.invalidateSize());
        ro.observe(wrapRef.current);
      }

      mapRef.current = map;
      setReady(true);
    })();

    return () => {
      cancelled = true;
      ro?.disconnect();
      map?.remove();
      mapRef.current = null;
      layerRef.current = null;
      medLayerRef.current = null;
      meLayerRef.current = null;
      draftRef.current = null;
      markersRef.current.clear();
      setReady(false);
    };
  }, []);

  // Sluta följa positionen när sidan lämnas
  useEffect(() => () => {
    if (watchRef.current !== null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    stopBulkRef.current = true;
    clearTimeout(toastTimer.current);
  }, []);

  // Sjukvårdslagret: egna markörer med en ruta som visar telefon och väg dit
  useEffect(() => {
    const L = LRef.current, layer = medLayerRef.current, map = mapRef.current;
    if (!ready || !L || !layer || !map) return;
    layer.clearLayers();
    if (!showMed) { map.removeLayer(layer); return; }
    if (!map.hasLayer(layer)) layer.addTo(map);
    const label: Record<string, string> = { station: 'Sjukvårdsstation', forsta_hjalpen: 'Första hjälpen', hjartstartare: 'Hjärtstartare' };
    for (const m of med) {
      const kind = ['station', 'forsta_hjalpen', 'hjartstartare'].includes(str(m.kind)) ? str(m.kind) : 'station';
      const lat = num(m.lat) as number, lng = num(m.lng) as number;
      const icon = L.divIcon({
        className: 'mk-wrap',
        html: `<div class="mk-med ${kind}">${kind === 'hjartstartare' ? '♥' : '+'}</div>`,
        iconSize: [26, 26], iconAnchor: [13, 13]
      });
      const tel = telHref(str(m.phone));
      const html = `<b>${escapeHtml(str(m.name))}</b><br>${label[kind]}${str(m.hours) ? ` · ${escapeHtml(str(m.hours))}` : ''}`
        + (str(m.address) ? `<br>${escapeHtml(str(m.address))}` : '')
        + (tel ? `<br><a href="${tel}">${escapeHtml(str(m.phone))}</a>` : '')
        + `<br><a href="${directionsHref(lat, lng, ios)}" target="_blank" rel="noopener noreferrer">Vägbeskrivning</a>`;
      L.marker([lat, lng], { icon, title: str(m.name), zIndexOffset: 2000 }).bindPopup(html).addTo(layer);
    }
  }, [ready, med, showMed, ios]);

  // Markörerna: uppdatera bara det som ändrats, så att kartan inte blinkar
  // när en incident kommer in i realtid.
  useEffect(() => {
    const L = LRef.current, layer = layerRef.current;
    if (!ready || !L || !layer) return;
    const seen = new Set<string>();

    for (const p of markerPlaces) {
      const lat = p.lat as number, lng = p.lng as number;
      const selected = p.key === selKey;
      const sig = markerSignature(p, selected);
      const st = statusOf(p);
      const z = selected ? 3000 : st === 'crit' ? 1500 : st === 'inc' ? 1000 : st === 'issue' ? 500 : 0;
      seen.add(p.key);

      const icon = () => L.divIcon({
        className: 'mk-wrap', html: markerHtml(p, selected), iconSize: [36, 36], iconAnchor: [18, 18]
      });

      const cur = markersRef.current.get(p.key);
      if (!cur) {
        const m = L.marker([lat, lng], { icon: icon(), title: p.name, zIndexOffset: z, riseOnHover: true });
        const key = p.key;
        m.on('click', () => onMarkerClick.current(key));
        m.bindTooltip(escapeHtml(p.name), {
          permanent: true, direction: 'bottom', offset: [0, 12], className: 'mk-label', opacity: 1
        });
        m.addTo(layer);
        markersRef.current.set(p.key, { m, sig });
      } else {
        const ll = cur.m.getLatLng();
        if (ll.lat !== lat || ll.lng !== lng) cur.m.setLatLng([lat, lng]);
        if (cur.sig !== sig) {
          cur.m.setIcon(icon());
          cur.sig = sig;
        }
        cur.m.setZIndexOffset(z);
        cur.m.setTooltipContent(escapeHtml(p.name));
      }
    }

    for (const [k, v] of markersRef.current) {
      if (!seen.has(k)) {
        layer.removeLayer(v.m);
        markersRef.current.delete(k);
      }
    }
  }, [ready, markerPlaces, selKey]);

  const fitTo = useCallback((pts: [number, number][]) => {
    const map = mapRef.current, L = LRef.current;
    if (!map || !L || !pts.length) return;
    if (pts.length === 1) { map.setView(pts[0], 16); return; }
    map.fitBounds(L.latLngBounds(pts), { padding: [44, 44], maxZoom: 16 });
  }, []);

  const select = useCallback((key: string | null, zoomIn = false) => {
    setSelKey(key);
    if (key) setFocusReq({ key, zoomIn, n: Date.now() });
  }, []);

  // Första vyn: hela turneringen (utan avvikande punkter), eller platsen
  // som länkades hit. Saknas koordinater helt: turneringens stad.
  useEffect(() => {
    if (!ready || loading) return;
    const map = mapRef.current;
    if (!map) return;

    if (focus && !focusDoneRef.current) {
      focusDoneRef.current = true;
      const p = places.find((x) => x.key === focus);
      if (p && isPlaced(p)) { fittedRef.current = true; select(p.key, true); return; }
      if (p && canEdit) { startPlace(p); }
    }

    const pts = corePoints(visible.map((p) => [p.lat as number, p.lng as number] as [number, number]));
    if (pts.length) {
      fitTo(pts);
      fittedRef.current = true;
    } else if (!fittedRef.current && !cityTriedRef.current && tn.city) {
      cityTriedRef.current = true;
      fetch(`/api/geocode?q=${encodeURIComponent(tn.city)}`)
        .then((r) => r.json())
        .then((d: { hit?: Hit | null }) => {
          if (d.hit && !fittedRef.current) mapRef.current?.setView([d.hit.lat, d.hit.lng], 12);
        })
        .catch(() => {});
    }
    // Medvetet inte beroende av places: en realtidsuppdatering ska inte
    // rycka kartan ur handen på den som tittar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, loading, filter]);

  // Centrera en punkt i den del av kartan som panelen inte täcker
  const showAbovePanel = useCallback((lat: number, lng: number, zoom?: number) => {
    const map = mapRef.current;
    if (!map) return;
    const h = sheetRef.current?.offsetHeight ?? 0;
    const z = zoom ?? map.getZoom();
    const pt = map.project([lat, lng], z).add([0, h / 2]);
    map.setView(map.unproject(pt, z), z, { animate: true });
  }, []);

  // Vald plats: se till att markören syns ovanför panelen
  useEffect(() => {
    if (!focusReq || !ready) return;
    const map = mapRef.current;
    const p = places.find((x) => x.key === focusReq.key);
    if (!map || !p || p.lat === null || p.lng === null) return;
    if (focusReq.zoomIn) {
      showAbovePanel(p.lat, p.lng, Math.max(map.getZoom(), 15));
      return;
    }
    // Tryck på markör: flytta bara kartan om markören hamnar under panelen
    // eller i kanten. Annars står kartan still, så man inte tappar bort sig.
    const h = sheetRef.current?.offsetHeight ?? 0;
    const size = map.getSize();
    const pt = map.latLngToContainerPoint([p.lat, p.lng]);
    const hidden = pt.y > size.y - h - 40 || pt.y < 60 || pt.x < 30 || pt.x > size.x - 30;
    if (hidden) showAbovePanel(p.lat, p.lng);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq, ready]);

  // Flytt: nålen ska synas ovanför redigeringspanelen från början
  useEffect(() => {
    if (!ready || !edit || edit.mode !== 'move' || edit.lat === null || edit.lng === null) return;
    const map = mapRef.current;
    showAbovePanel(edit.lat, edit.lng, Math.max(map?.getZoom() ?? 15, 16));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, edit?.key, edit?.mode]);

  // Min position: blå prick och osäkerhetscirkel
  useEffect(() => {
    const L = LRef.current, layer = meLayerRef.current;
    if (!ready || !L || !layer) return;
    layer.clearLayers();
    if (!me) return;
    L.circle([me.lat, me.lng], {
      radius: Math.min(me.acc, 2000), color: '#2F80ED', weight: 1, fillOpacity: 0.12, interactive: false
    }).addTo(layer);
    L.circleMarker([me.lat, me.lng], {
      radius: 8, color: '#fff', weight: 3, fillColor: '#2F80ED', fillOpacity: 1, interactive: false
    }).addTo(layer);
  }, [ready, me]);

  // Nålen när en plats placeras eller flyttas. Går att dra.
  useEffect(() => {
    const L = LRef.current, map = mapRef.current;
    if (!ready || !L || !map) return;
    const lat = edit?.lat ?? null, lng = edit?.lng ?? null;
    if (lat === null || lng === null) {
      if (draftRef.current) { draftRef.current.remove(); draftRef.current = null; }
      return;
    }
    if (!draftRef.current) {
      const m = L.marker([lat, lng], {
        draggable: true, zIndexOffset: 5000, autoPan: true,
        // Egen klass: i placeringsläget släpper vanliga markörer igenom tryck,
        // men nålen måste gå att dra
        icon: L.divIcon({ className: 'mk-pin', html: '<div class="mk-draft"></div>', iconSize: [36, 40], iconAnchor: [18, 37] })
      });
      m.on('dragend', () => {
        const ll = m.getLatLng();
        setEdit((cur) => (cur ? { ...cur, lat: ll.lat, lng: ll.lng, note: '' } : cur));
      });
      m.addTo(map);
      draftRef.current = m;
    } else {
      const ll = draftRef.current.getLatLng();
      if (ll.lat !== lat || ll.lng !== lng) draftRef.current.setLatLng([lat, lng]);
    }
  }, [ready, edit?.lat, edit?.lng]);

  // ---------- Handlingar ----------
  onMapClick.current = (lat, lng) => {
    if (edit) {
      setEdit({ ...edit, lat, lng, note: '' });
      return;
    }
    setSelKey(null);
  };
  onMarkerClick.current = (key) => {
    if (edit) return;
    select(key, false);
  };

  // Scrolla upp till kartan först när React ritat klart. Görs det direkt i
  // klickhanteraren avbryts den mjuka scrollningen av samma rendering
  // (knappen man tryckte på blir inaktiv) och sidan står kvar längst ner.
  const [scrollReq, setScrollReq] = useState(0);
  const scrollToMap = () => setScrollReq((n) => n + 1);
  useEffect(() => {
    if (!scrollReq) return;
    const el = wrapRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 76;
    if (Math.abs(window.scrollY - Math.max(0, top)) < 4) return;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [scrollReq]);

  const toggleMe = () => {
    setErr('');
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      setMe(null);
      setLocating(false);
      return;
    }
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setErr('Den här enheten kan inte dela sin position.');
      return;
    }
    setLocating(true);
    setSelKey(null);
    meCenteredRef.current = false;
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
        setLocating(false);
        setMe(next);
        if (!meCenteredRef.current) {
          meCenteredRef.current = true;
          // Ungefär en kilometer runt sig: lagom för att se närmaste boenden
          const map = mapRef.current;
          const z = map?.getZoom() ?? 15;
          map?.setView([next.lat, next.lng], z >= 14 && z <= 16 ? z : 15);
        }
      },
      (e) => {
        setLocating(false);
        if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
        setMe(null);
        setErr(e.code === 1
          ? 'Platsåtkomst nekad. Tillåt plats för webbläsaren i telefonens inställningar och försök igen.'
          : 'Kunde inte hämta din position just nu.');
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
  };

  const showAll = () => {
    setSelKey(null);
    fitTo(visible.map((p) => [p.lat as number, p.lng as number] as [number, number]));
  };

  const changeFilter = (f: Filter) => {
    setFilter(f);
    setSelKey(null);
    setListMax(LIST_STEP);
  };

  const focusFromList = (p: Place) => {
    if (edit) return;
    scrollToMap();
    select(p.key, true);
  };

  const geocode = useCallback(async (query: string): Promise<{ hit: Hit | null; error?: string }> => {
    const box = searchBox(placed.map((p) => [p.lat as number, p.lng as number] as [number, number]));
    const params = new URLSearchParams({ q: query });
    if (box) params.set('box', [box.w, box.s, box.e, box.n].map((v) => v.toFixed(4)).join(','));
    try {
      const res = await fetch(`/api/geocode?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { hit: null, error: body.error || 'Adressökningen misslyckades' };
      return { hit: body.hit ?? null };
    } catch {
      return { hit: null, error: 'Ingen kontakt med adressökningen' };
    }
  }, [placed]);

  // Sparar och kontrollerar att raden faktiskt ändrades. RLS säger inte
  // nej med ett fel – en otillåten ändring påverkar bara noll rader.
  const savePos = useCallback(async (p: Place, lat: number, lng: number): Promise<string | null> => {
    const patch: Record<string, unknown> = { lat, lng };
    if (p.hasFlagColumn) patch.coord_flagged = false;
    const { data, error } = await supabase
      .from(p.type === 'school' ? 'schools' : 'arenas')
      .update(patch).eq('id', p.id).select('id');
    if (error) return error.message;
    if (!data || data.length === 0) return 'Du saknar behörighet att ändra platser.';
    setPlaces((prev) => prev.map((x) => (x.key === p.key ? { ...x, lat, lng, flagged: false } : x)));
    return null;
  }, [supabase]);

  function startPlace(p: Place) {
    setErr('');
    setSelKey(null);
    setEdit({ key: p.key, mode: 'place', lat: null, lng: null, note: '', busy: false });
    scrollToMap();
  }

  const startMove = (p: Place) => {
    setErr('');
    setEdit({ key: p.key, mode: 'move', lat: p.lat, lng: p.lng, note: '', busy: false });
  };

  const lookup = async () => {
    if (!edit || !editPlace) return;
    const query = geocodeQuery(editPlace, tn.city);
    setEdit({ ...edit, busy: true, note: 'Söker…' });
    const r = await geocode(query);
    if (r.hit) {
      setEdit((cur) => cur && { ...cur, busy: false, lat: r.hit!.lat, lng: r.hit!.lng, note: `Hittade: ${r.hit!.label}` });
      showAbovePanel(r.hit.lat, r.hit.lng, 17);
    } else {
      setEdit((cur) => cur && {
        ...cur, busy: false,
        note: r.error ?? `Ingen träff på "${query}". Tryck på kartan där platsen ligger.`
      });
    }
  };

  const saveEdit = async () => {
    if (!edit || !editPlace || edit.lat === null || edit.lng === null) return;
    setEdit({ ...edit, busy: true });
    const e = await savePos(editPlace, edit.lat, edit.lng);
    if (e) {
      setEdit((cur) => cur && { ...cur, busy: false, note: e });
      return;
    }
    const key = edit.key;
    setEdit(null);
    select(key, false);
    flash('Positionen sparad');
  };

  // Hämta positioner för alla som saknar, en i taget. Adresstjänsten tillåter
  // högst ett anrop i sekunden, så det här tar en stund för många platser.
  const runBulk = async () => {
    const targets = missing.filter((p) => (p.address || p.name).trim().length >= 3);
    if (!targets.length) return;
    stopBulkRef.current = false;
    let done = 0, found = 0;
    const notFound: string[] = [];
    setBulk({ total: targets.length, done, found, running: true, notFound, error: '' });

    for (const p of targets) {
      if (stopBulkRef.current) break;
      const r = await geocode(geocodeQuery(p, tn.city));
      if (r.error) {
        setBulk({ total: targets.length, done, found, running: false, notFound, error: r.error });
        return;
      }
      if (r.hit) {
        const e = await savePos(p, r.hit.lat, r.hit.lng);
        if (e) {
          setBulk({ total: targets.length, done, found, running: false, notFound, error: e });
          return;
        }
        found++;
      } else {
        notFound.push(p.name);
      }
      done++;
      setBulk({ total: targets.length, done, found, running: true, notFound: [...notFound], error: '' });
    }
    setBulk({ total: targets.length, done, found, running: false, notFound, error: '' });
    if (found) flash(`${found} platser placerade`);
  };

  // ---------- Visning ----------
  const dist = (p: Place) => (me && p.lat !== null && p.lng !== null
    ? fmtDistance(distanceM([me.lat, me.lng], [p.lat, p.lng]))
    : '');

  const badges = (p: Place) => (
    <>
      {p.incidents.length > 0 && (
        <span className="badge b-critical">{p.incidents.length} incident{p.incidents.length > 1 ? 'er' : ''}</span>
      )}
      {p.issues > 0 && <span className="badge b-medium">{p.issues} fel</span>}
    </>
  );

  const chips: { f: Filter; label: string; n: number; hide?: boolean }[] = [
    { f: 'all', label: 'Alla', n: counts.all },
    { f: 'boende', label: tn.labels.schools, n: counts.boende },
    { f: 'hotell', label: 'Hotell', n: counts.hotell, hide: counts.hotell === 0 },
    { f: 'arena', label: tn.labels.playingAreas, n: counts.arena },
    { f: 'problem', label: 'Problem', n: counts.problem, hide: counts.problem === 0 && filter !== 'problem' }
  ];

  const selTel = sel ? telHref(sel.contactPhone) : null;
  const withAddress = missing.filter((p) => (p.address || p.name).trim().length >= 3).length;

  return (
    <>
      <h1 className="page-title">Karta</h1>
      <div className="page-sub">
        {loading
          ? 'Laddar platser…'
          : `${placed.length} på kartan${missing.length ? ` · ${missing.length} saknar position` : ''}`}
      </div>

      <div className="chips">
        {chips.filter((c) => !c.hide).map((c) => (
          <button key={c.f} className={`chip ${filter === c.f ? 'active' : ''}`} onClick={() => changeFilter(c.f)}>
            {c.label} <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>{c.n}</span>
          </button>
        ))}
        {med.length > 0 && (
          <button className={`chip ${showMed ? 'active' : ''}`} onClick={() => setShowMed(!showMed)} aria-pressed={showMed}>
            Sjukvård <span className="mono" style={{ marginLeft: 6, opacity: 0.7 }}>{med.length}</span>
          </button>
        )}
      </div>

      {loadErr && <div className="form-error" style={{ marginBottom: 10 }}>{loadErr}</div>}
      {err && <div className="form-error" style={{ marginBottom: 10 }}>{err}</div>}

      <div ref={wrapRef} className={`map-wrap ${edit ? 'placing' : ''}`}>
        <div ref={boxRef} className="map-box" />

        {!edit && (
          <div className="map-tools">
            <button className={`map-tool ${me ? 'on' : ''}`} onClick={toggleMe}
              aria-label={me ? 'Sluta visa min position' : 'Visa min position'}>
              <LocateFixed size={20} className={locating ? 'spin-slow' : ''} />
            </button>
            <button className="map-tool" onClick={showAll} aria-label="Visa alla platser">
              <Maximize2 size={19} />
            </button>
          </div>
        )}

        {toast && <div className="map-toast">{toast}</div>}
        {tilesDown && !toast && (
          <div className="map-toast warn">Kartbilderna laddas inte – markörerna fungerar ändå</div>
        )}

        {sel && !edit && (
          <div className="map-sheet" ref={sheetRef}>
            <div className="ms-head">
              <div style={{ minWidth: 0 }}>
                <div className="ms-kind">
                  {kindLabel(sel)}{sel.area ? ` · ${sel.area}` : ''}{dist(sel) ? ` · ${dist(sel)} bort` : ''}
                </div>
                <div className="ms-title">{sel.name}</div>
              </div>
              <button className="ms-close" onClick={() => setSelKey(null)} aria-label="Stäng">
                <X size={18} />
              </button>
            </div>

            <div className="ms-pills">
              {badges(sel)}
              {statusOf(sel) === 'ok' && <span className="badge b-resolved">Inget öppet</span>}
              {sel.type === 'school' && (sel.teamsIn > 0 || sel.teamsExpected > 0) && (
                <span className="badge b-low">
                  {sel.teamsIn} lag på plats{sel.inHouse ? ` · ${sel.inHouse} pers` : ''}
                  {sel.teamsExpected ? ` · ${sel.teamsExpected} väntas` : ''}
                </span>
              )}
              {sel.type === 'arena' && sel.surfaces ? (
                <span className="badge b-low">{sel.surfaces} {tn.labels.playingAreas.toLowerCase()}</span>
              ) : null}
            </div>

            {/* Knapparna först: de ska synas utan att man scrollar i panelen */}
            <div className="ms-actions">
              <Link className="btn btn-sm btn-primary" href={sel.type === 'school' ? `/schools/${sel.id}` : `/arenas/${sel.id}`}>
                Öppna
              </Link>
              {sel.lat !== null && sel.lng !== null && (
                <a className="btn btn-sm" href={directionsHref(sel.lat, sel.lng, ios)} target="_blank" rel="noopener noreferrer">
                  <Navigation size={15} /> Vägbeskrivning
                </a>
              )}
              {selTel && <a className="btn btn-sm" href={selTel}><Phone size={15} /> Ring</a>}
              {canEdit && (
                <button className="btn btn-sm btn-ghost" onClick={() => startMove(sel)}>
                  <Move size={15} /> Flytta
                </button>
              )}
            </div>

            {sel.incidents.slice(0, 3).map((i) => (
              <Link key={i.id} href={`/incidents/${i.id}`} className="ms-inc">
                <span className={`badge b-${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span>
                <span className="ms-inc-title">{i.title}</span>
              </Link>
            ))}

            {(sel.address || sel.contactName || sel.contactPhone || sel.club) && (
              <div className="ms-info">
                {sel.address && <div><MapPin size={14} /> {sel.address}</div>}
                {(sel.contactName || sel.contactPhone) && (
                  <div><Phone size={14} /> {[sel.contactName, sel.contactPhone].filter(Boolean).join(' · ')}</div>
                )}
                {sel.club && <div>Förening: {sel.club}</div>}
              </div>
            )}

            {(sel.assembly || sel.care || sel.emergency) && (
              <div className="ms-emerg">
                <div className="ms-emerg-head"><ShieldAlert size={14} /> Nödinfo</div>
                {sel.assembly && <div><b>Återsamling:</b> {sel.assembly}</div>}
                {sel.care && <div><b>Närmaste vård:</b> {sel.care}</div>}
                {sel.emergency && <div>{sel.emergency}</div>}
              </div>
            )}

          </div>
        )}

        {edit && editPlace && (
          <div className="map-sheet map-edit" ref={sheetRef}>
            <div className="ms-head">
              <div style={{ minWidth: 0 }}>
                <div className="ms-kind">{edit.mode === 'move' ? 'Flytta' : 'Placera'} {kindLabel(editPlace).toLowerCase()}</div>
                <div className="ms-title">{editPlace.name}</div>
              </div>
              <button className="ms-close" onClick={() => setEdit(null)} disabled={edit.busy} aria-label="Avbryt">
                <X size={18} />
              </button>
            </div>
            <div className="ms-help">
              {edit.lat === null
                ? 'Tryck på kartan där platsen ligger.'
                : 'Dra nålen eller tryck igen för att justera.'}
              {editPlace.address ? <> Adress: {editPlace.address}</> : null}
            </div>
            {edit.note && <div className="ms-note">{edit.note}</div>}
            <div className="ms-actions">
              <button className="btn btn-sm btn-primary" onClick={saveEdit} disabled={edit.busy || edit.lat === null}>
                Spara position
              </button>
              <button className="btn btn-sm" onClick={lookup} disabled={edit.busy}>
                <Search size={15} /> Sök adress
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="map-legend">
        <span><i className="lg lg-ci lg-ok" /> {tn.labels.school}</span>
        <span><i className="lg lg-sq lg-arena" /> {tn.labels.playingArea}</span>
        <span><i className="lg lg-ci lg-issue" /> Öppet fel</span>
        <span><i className="lg lg-ci lg-inc" /> Öppen incident</span>
        {counts.hotell > 0 && <span><b className="lg-letter">H</b> Hotell</span>}
      </div>

      <div className="map-search">
        <Search size={17} />
        <input className="input" placeholder="Sök plats, adress, område…" value={q}
          onChange={(e) => { setQ(e.target.value); setListMax(LIST_STEP); }} />
      </div>

      {me && listRows.length > 0 && <div className="li-meta" style={{ margin: '0 0 8px' }}>Närmast dig först</div>}

      <div className="list">
        {listRows.slice(0, listMax).map((p) => (
          <button key={p.key} className={`list-item map-li ${p.key === selKey ? 'sel' : ''}`}
            onClick={() => focusFromList(p)}>
            <span className="map-li-glyph" dangerouslySetInnerHTML={{ __html: markerHtml(p, false) }} />
            <span className="map-li-body">
              <span className="li-title">{p.name}</span>
              <span className="li-meta">
                {kindLabel(p)}{p.area ? ` · ${p.area}` : ''}{dist(p) ? ` · ${dist(p)}` : ''}
              </span>
            </span>
            <span className="map-li-badges">{badges(p)}</span>
          </button>
        ))}
        {!loading && listRows.length === 0 && placed.length > 0 && (
          <div className="page-sub" style={{ marginBottom: 0 }}>Inga platser matchar.</div>
        )}
        {listRows.length > listMax && (
          <button className="btn" onClick={() => setListMax((n) => n + LIST_STEP * 2)}>
            Visa fler ({listRows.length - listMax} till)
          </button>
        )}
      </div>

      {missingRows.length > 0 && (
        <details className="map-missing" open={canEdit}>
          <summary>
            <Crosshair size={17} /> Saknar position <span className="badge b-medium">{missingRows.length}</span>
          </summary>

          {canEdit ? (
            <div className="map-bulk">
              {!bulk?.running ? (
                <>
                  <div className="li-meta" style={{ marginTop: 0 }}>
                    Tryck <b>Placera</b> och sedan på kartan, eller hämta positioner från adresserna
                    automatiskt. Kontrollera markörerna efteråt – en adress kan hamna fel.
                  </div>
                  <button className="btn btn-sm" onClick={runBulk} disabled={!withAddress || !!edit}>
                    <Search size={15} /> Hämta från adresser ({withAddress})
                  </button>
                </>
              ) : (
                <>
                  <div className="li-meta" style={{ marginTop: 0 }}>
                    Söker {bulk.done + 1 > bulk.total ? bulk.total : bulk.done + 1} av {bulk.total} · {bulk.found} hittade
                  </div>
                  <div className="prog"><div style={{ width: `${(bulk.done / bulk.total) * 100}%` }} /></div>
                  <button className="btn btn-sm btn-ghost" onClick={() => { stopBulkRef.current = true; }}>Avbryt</button>
                </>
              )}
              {bulk && !bulk.running && (
                <div className={bulk.error ? 'form-error' : 'ok-msg'} style={{ marginTop: 8 }}>
                  {bulk.error
                    ? `${bulk.error}. ${bulk.found} placerades innan det stoppade.`
                    : `${bulk.found} av ${bulk.done} placerade.${bulk.notFound.length ? ` Ingen träff: ${bulk.notFound.slice(0, 5).join(', ')}${bulk.notFound.length > 5 ? ' m.fl.' : ''}.` : ''}`}
                </div>
              )}
            </div>
          ) : (
            <div className="li-meta" style={{ margin: '0 0 10px' }}>
              En administratör kan placera dem direkt på kartan.
            </div>
          )}

          <div className="list">
            {missingRows.map((p) => (
              <div key={p.key} className="list-item map-li">
                <span className="map-li-glyph" dangerouslySetInnerHTML={{ __html: markerHtml(p, false) }} />
                <span className="map-li-body">
                  <span className="li-title">{p.name}</span>
                  <span className="li-meta">
                    {kindLabel(p)}{p.area ? ` · ${p.area}` : ''}
                    {p.address ? ` · ${p.address}` : ' · ingen adress'}
                    {p.flagged ? ' · fel koordinat vid import' : ''}
                    {p.flagged && p.raw ? ` (${p.raw})` : ''}
                  </span>
                </span>
                {canEdit && (
                  <button className="btn btn-sm" onClick={() => startPlace(p)} disabled={!!edit || !!bulk?.running}>
                    Placera
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
