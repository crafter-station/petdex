import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { isCollaborator } from "@/lib/admin";

import AdminCollectionRequestsPage from "../../admin/collection-requests/page";

export const metadata = {
  title: "Petdex Collaborator · Collection requests",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CollaboratorCollectionRequestsPage() {
  const { userId } = await auth();
  if (!isCollaborator(userId)) notFound();

  return <AdminCollectionRequestsPage />;
}
