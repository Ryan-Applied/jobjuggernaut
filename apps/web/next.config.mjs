/** @type {import('next').NextConfig} */
export default { reactStrictMode: true, env: { NEXT_PUBLIC_API_URL: process.env.API_URL ?? "http://localhost:4000" } };
