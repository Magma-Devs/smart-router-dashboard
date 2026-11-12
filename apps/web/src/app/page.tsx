import { redirect } from "next/navigation";
import { HOME_PATH } from "@/lib/home-path";

export default function Home() {
  redirect(HOME_PATH);
}
