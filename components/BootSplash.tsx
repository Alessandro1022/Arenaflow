'use client';
import { useEffect } from 'react';

// Tar bort laddningsrutan som servern ritat (#boot-splash) när appen har startat.
// Rutan döljs också av CSS efter en tidsgräns, så den kan aldrig fastna.
export default function BootSplash() {
  useEffect(() => {
    document.getElementById('boot-splash')?.remove();
  }, []);
  return null;
}
