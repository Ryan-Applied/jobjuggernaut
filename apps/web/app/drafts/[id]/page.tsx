import { DraftReview } from "@/components/DraftReview";
export default function Page({ params }: { params: { id: string } }) { return <DraftReview id={params.id} />; }
