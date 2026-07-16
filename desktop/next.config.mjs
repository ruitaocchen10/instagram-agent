/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tauri serves a static frontend — there is no Node server at runtime,
  // so we export the app to plain static files in ./out.
  output: "export",
  // No image-optimization server exists in a static export.
  images: { unoptimized: true },
};

export default nextConfig;
