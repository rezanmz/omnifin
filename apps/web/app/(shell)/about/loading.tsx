import { AboutScreenSkeleton } from "../../../components/about-screen";

export default function AboutLoading() {
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return <AboutScreenSkeleton displayProfile={displayProfile} />;
}
