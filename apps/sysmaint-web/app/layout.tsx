import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "SysMaint Dashboard",
  description: "Signal-encrypted SysMaint operations console"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">SysMaint</div>
          <nav>
            <a href="/">Dashboard</a>
            <a href="/chat">Alice Chat</a>
            <a href="/demo">Demo</a>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
