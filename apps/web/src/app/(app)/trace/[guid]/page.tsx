import { TraceView } from "@/components/trace/TraceView";

/** `/trace/<guid>` — deep-linkable, which is most of the point: a trace is
 *  something you paste to whoever is on call. */
export default async function TraceDetailPage({ params }: { params: Promise<{ guid: string }> }) {
  const { guid } = await params;
  // Keyed: a different relay is a different question, so it gets a fresh
  // component rather than one relay's answer sitting under another's lines.
  return <TraceView key={guid} guid={guid} />;
}
