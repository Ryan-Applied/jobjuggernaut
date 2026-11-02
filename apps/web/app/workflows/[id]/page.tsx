import { WorkflowDetail } from "@/components/WorkflowDetail";
export default function Page({ params }: { params: { id: string } }) { return <WorkflowDetail id={params.id} />; }
