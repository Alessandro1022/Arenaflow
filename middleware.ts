import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseUrl, supabaseAnonKey } from '@/lib/supabase/env';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    supabaseUrl(),
    supabaseAnonKey(),
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(toSet: { name: string; value: string; options: CookieOptions }[]) {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        }
      }
    }
  );

  // Timeout-skydd: en sovande eller långsam databas ska inte släcka hela sajten
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
  const result = await Promise.race([supabase.auth.getUser(), timeout]);

  // Inget svar i tid – släpp igenom, sidorna gör sin egen kontroll
  if (result === null) return response;

  const user = result.data.user;
  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith('/login') || path.startsWith('/auth') || path.startsWith('/api')
    || path.startsWith('/integritet');

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (user && path.startsWith('/login')) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }
  return response;
}

// Service workern och offlinesidan måste nås utan inloggning: en omdirigering
// till /login gör att uppdateringen av workern misslyckas.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest.json|sw\\.js|offline-sw\\.js|offline\\.html|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)']
};
