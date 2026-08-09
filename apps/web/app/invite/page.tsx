import type { Metadata } from "next";

import { InviteExperience } from "../../components/invite-experience";
import "../globals.css";
import "./invite.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  description: "Accept a private, single-use Omnifin invitation.",
  title: "Accept invitation",
};

export default function InvitePage() {
  return <InviteExperience />;
}
