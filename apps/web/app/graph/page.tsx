import { GraphExplorer } from "@/components/GraphExplorer";
export default function Page({ searchParams }: { searchParams: { node?: string } }) { return <GraphExplorer initial={searchParams.node} />; }
