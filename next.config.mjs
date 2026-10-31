/** @type {import('next').NextConfig} */

// Byggets id. Service workern får det som version, så att varje ny
// driftsättning installeras på telefonerna av sig själv.
const build = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 12) || String(Date.now());

const nextConfig = {
  reactStrictMode: true,
  env: { TOPS_BUILD: build }
};

export default nextConfig;
