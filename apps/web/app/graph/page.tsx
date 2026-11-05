import { GraphExplorer } from "@/components/GraphExplorer";
export default async function Page({ searchParams }: { searchParams: Promise<{ node?: string }> }) {
  const { node } = await searchParams;
  return <GraphExplorer initial={node} />;
}
