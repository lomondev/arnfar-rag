import { StudioNav } from "@/features/studio/StudioNav";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <StudioNav />
      {children}
    </div>
  );
}
