import { FullAuthProviders } from "@/components/auth/auth-providers";

export default function UserProfileLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <FullAuthProviders>{children}</FullAuthProviders>;
}
