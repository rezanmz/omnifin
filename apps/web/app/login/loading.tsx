import { LoginScreenSkeleton } from "../../components/login-screen";

export default function LoginLoading() {
  const displayProfile =
    process.env.OMNIFIN_DISPLAY_PROFILE === "ten-foot" ? "ten-foot" : "standard";
  return <LoginScreenSkeleton displayProfile={displayProfile} />;
}
