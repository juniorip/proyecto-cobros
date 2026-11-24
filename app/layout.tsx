import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Control de cobros BCP",
  description: "Importa reportes CREP y controla tus cobros sin duplicados.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="antialiased">{children}</body>
    </html>
  );
}
