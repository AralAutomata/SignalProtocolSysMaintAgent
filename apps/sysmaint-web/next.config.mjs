/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@mega/sysmaint-protocol"],
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "@signalapp/libsignal-client", "@mega/signal-core"]
  }
};

export default nextConfig;
