import { Providers } from "@/components/providers";
import { Toaster } from "@/components/ui/toaster";
import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  fallback: ["system-ui", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-heading",
});

const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://aural-ai.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "数君 · AI 面试",
    template: "%s | 数君面试",
  },
  description:
    "数君 AI 面试:结构化的语音 / 文字面试,自动初筛、实时洞察。",
  keywords: [
    "AI interview platform",
    "voice interview",
    "AI interviews",
    "interview platform",
    "structured interviews",
    "voice interviews",
    "video interviews",
    "AI voice interview",
    "automated interviews",
    "interview automation",
    "candidate assessment",
    "interview analytics",
  ],
  alternates: {
    canonical: siteUrl,
  },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "数君",
    title: "数君 · AI 面试",
    description:
      "数君 AI 面试:结构化的语音 / 文字面试,自动初筛、实时洞察。",
    url: siteUrl,
    images: [
      {
        url: `${siteUrl}/images/marketing/hero-screenshots.webp`,
        width: 1920,
        height: 960,
        alt: "数君 AI 面试",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "数君 · AI 面试",
    description:
      "数君 AI 面试:结构化的语音 / 文字面试,自动初筛、实时洞察。",
    images: [`${siteUrl}/images/marketing/hero-screenshots.webp`],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body className={inter.className}>
        <Providers>
          {children}
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
