import { PendingEditsReviewPage } from "@/components/pending-edits-review-page";

export const metadata = {
  title: "Petdex Admin · Edits",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function AdminEditsPage() {
  return <PendingEditsReviewPage />;
}
