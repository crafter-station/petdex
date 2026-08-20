import { FullAuthProviders } from "@/components/auth/auth-providers";

export default function MyFeedbackLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <FullAuthProviders>{children}</FullAuthProviders>;
}
