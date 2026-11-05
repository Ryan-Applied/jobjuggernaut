import { DraftReview } from "@/components/DraftReview";
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DraftReview id={id} />;
}
