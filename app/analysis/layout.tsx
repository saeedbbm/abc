import { Metadata } from "next";

export const metadata: Metadata = {
    title: "System Analysis — Pidrax",
    description: "System health metrics and per-company analysis",
};

export default function AnalysisLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return <>{children}</>;
}
