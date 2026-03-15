import type { Metadata } from "next";
import { Manrope } from "next/font/google";

import "./globals.css";

const bodyFont = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "Live Translate",
  description: "Turn-based speech translation and interpretation powered by Groq.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={bodyFont.variable}>{children}</body>
    </html>
  );
}
