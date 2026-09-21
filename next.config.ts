import type { NextConfig } from 'next';
// BEIGNET_BASE_PATH lets the static export live under a path prefix, such as a
// GitHub Pages project site. Leave it unset to serve from the origin root.
const basePath = (process.env.BEIGNET_BASE_PATH ?? '').replace(/\/+$/, '');
const nextConfig: NextConfig = { output: 'export', basePath };
export default nextConfig;
