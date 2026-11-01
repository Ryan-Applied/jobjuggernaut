import "./globals.css";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/Sidebar";

export const metadata = { title: "Control plane" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
