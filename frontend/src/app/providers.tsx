"use client";

import dynamic from "next/dynamic";
import React from "react";

// Dynamically import providers to avoid SSR issues with RainbowKit's localStorage usage
const ProvidersInner = dynamic(
    () => import("@/app/providers-inner").then((mod) => mod.ProvidersInner),
    { ssr: false }
) as React.ComponentType<{ children: React.ReactNode }>;

export function Providers({ children }: { children: React.ReactNode }) {
    return <ProvidersInner>{children}</ProvidersInner>;
}
