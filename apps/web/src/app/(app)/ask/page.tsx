import { notFound } from "next/navigation";
import { AskFullView } from "@/components/ask/AskData";

/** Ask your data, full screen: the same chats as the side panel, with room to read and dig in. Preview only. */
export default function AskPage() {
  if (process.env.ASK_DATA_PREVIEW?.trim().toLowerCase() !== "true") notFound();
  return <AskFullView />;
}
