import { PetRequestsReviewPage } from "@/components/pet-requests-review-page";

export const metadata = {
  title: "Petdex Admin · Requests",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function AdminRequestsPage() {
  return <PetRequestsReviewPage />;
}
