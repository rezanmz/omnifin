"use client";

import type {
  AdministratorRecoveryPreviewAdministrator,
  AuthProvider,
  JellyfinQuickConnectInitiationResponse,
} from "@omnifin/contracts/auth";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
  administratorRecoveryClient,
  type AdministratorRecoveryClient,
  type AdministratorRecoveryFailure,
  type AdministratorRecoveryTargetInput,
} from "../lib/administrator-recovery";
import styles from "./administrator-recovery-ceremony.module.css";
import { BrandMark } from "./brand-mark";
import { CinematicBackdrop } from "./cinematic-backdrop";

type CeremonyStep = "confirmation" | "preview" | "proof";
type ProofMethod = "oidc" | "password" | "quick-connect";
type BlockingState =
  | "denied"
  | "loading"
  | "rate_limited"
  | "ready"
  | "session_required"
  | "session_unconfirmed"
  | "stale_target"
  | "success"
  | "target_unavailable"
  | "unavailable";
type NoticeState = "denied" | "rate_limited" | "unavailable";
type OperationState =
  | "checking_session"
  | "idle"
  | "oidc_starting"
  | "password_submitting"
  | "quick_pending"
  | "quick_starting";

export type AdministratorRecoveryCeremonyInitialState = Exclude<BlockingState, "loading" | "ready">;

export interface AdministratorRecoveryCeremonyProperties {
  autoPollQuickConnect?: boolean;
  client?: AdministratorRecoveryClient;
  csrfToken?: string;
  displayProfile?: DisplayProfile;
  initialConfirmation?: string;
  initialMethod?: ProofMethod;
  initialNotice?: NoticeState;
  initialPreview?: AdministratorRecoveryPreviewAdministrator;
  initialProviders?: readonly AuthProvider[];
  initialQuickConnectTransaction?: JellyfinQuickConnectInitiationResponse;
  initialState?: AdministratorRecoveryCeremonyInitialState;
  initialStep?: CeremonyStep;
  onAuthenticated?: () => void;
  onFirstAdministratorSetup?: () => void;
  onOidcRedirect?: (authorizationUrl: string) => void;
}

const BLOCKING_COPY: Readonly<
  Record<Exclude<BlockingState, "loading" | "ready" | "success">, { body: string; title: string }>
> = Object.freeze({
  denied: {
    body: "This recovery session cannot perform the replacement. No account details were returned and no authority changed.",
    title: "Administrator replacement was denied",
  },
  rate_limited: {
    body: "The gateway asked this browser to wait before another recovery request. No authority changed. You can return later without keeping this page open.",
    title: "Recovery requests are rate limited",
  },
  session_required: {
    body: "The short-lived recovery session ended or changed. Open recovery access again before reviewing another target.",
    title: "Recovery access has ended",
  },
  session_unconfirmed: {
    body: "OmniFin could not confirm the normal replacement session. Do not submit the authority change again. Check the session safely, or return to sign in.",
    title: "The new session needs to be checked",
  },
  stale_target: {
    body: "The shown administrator record changed after it was reviewed. OmniFin stopped before moving authority. Load a fresh preview before continuing.",
    title: "The administrator preview is no longer current",
  },
  target_unavailable: {
    body: "OmniFin could not provide a sole-administrator target. No account details were returned and no authority changed.",
    title: "Administrator replacement is not available",
  },
  unavailable: {
    body: "The recovery control plane could not complete this check. No authority changed. It is safe to request a fresh preview.",
    title: "Administrator recovery is temporarily unavailable",
  },
});

const NOTICE_COPY: Readonly<Record<NoticeState, string>> = Object.freeze({
  denied:
    "That fresh identity proof was not accepted for administrator replacement. No local authority changed.",
  rate_limited:
    "This proof method is temporarily rate limited. No authority changed. You can leave this page and return later.",
  unavailable:
    "The proof could not be completed. No authority changed, and it is safe to try this proof again.",
});

const revisionFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
  timeZoneName: "short",
  year: "numeric",
});

function formattedRevision(value: string) {
  return revisionFormatter.format(new Date(value));
}

function authenticationMethodLabel(method: "jellyfin" | "oidc") {
  return method === "jellyfin" ? "Jellyfin" : "OIDC";
}

function defaultAuthenticatedNavigation() {
  window.location.replace("/");
}

function defaultOidcRedirect(authorizationUrl: string) {
  window.location.replace(authorizationUrl);
}

function initialBlockingState(
  initialPreview: AdministratorRecoveryPreviewAdministrator | undefined,
  initialState: AdministratorRecoveryCeremonyInitialState | undefined,
): BlockingState {
  if (initialState === "success" || initialState === "session_unconfirmed") return initialState;
  if (initialPreview && initialState !== "stale_target") return "ready";
  return initialState ?? "loading";
}

function initialNoticeState(
  initialPreview: AdministratorRecoveryPreviewAdministrator | undefined,
  initialState: AdministratorRecoveryCeremonyInitialState | undefined,
  initialNotice: NoticeState | undefined,
): NoticeState | null {
  if (initialNotice) return initialNotice;
  return initialPreview &&
    (initialState === "denied" || initialState === "rate_limited" || initialState === "unavailable")
    ? initialState
    : null;
}

function ProofIcon({ method }: { method: ProofMethod }) {
  if (method === "password") return <KeyRound aria-hidden="true" size={20} />;
  if (method === "quick-connect") return <Smartphone aria-hidden="true" size={20} />;
  return <Fingerprint aria-hidden="true" size={20} />;
}

function availableProofMethods(providers: readonly AuthProvider[]) {
  const jellyfin = providers.find(
    (provider): provider is Extract<AuthProvider, { kind: "jellyfin" }> =>
      provider.kind === "jellyfin" && provider.state === "available",
  );
  const methods: ProofMethod[] = [];
  if (jellyfin?.passwordLoginAvailable) methods.push("password");
  if (jellyfin?.quickConnectAvailable) methods.push("quick-connect");
  if (providers.some((provider) => provider.kind === "oidc" && provider.state === "available")) {
    methods.push("oidc");
  }
  return methods;
}

export function AdministratorRecoveryCeremony({
  autoPollQuickConnect = true,
  client = administratorRecoveryClient,
  csrfToken,
  displayProfile = "standard",
  initialConfirmation = "",
  initialMethod = "password",
  initialNotice,
  initialPreview,
  initialProviders,
  initialQuickConnectTransaction,
  initialState,
  initialStep = "preview",
  onAuthenticated = defaultAuthenticatedNavigation,
  onFirstAdministratorSetup,
  onOidcRedirect = defaultOidcRedirect,
}: AdministratorRecoveryCeremonyProperties) {
  const [blockingState, setBlockingState] = useState<BlockingState>(() =>
    initialBlockingState(initialPreview, initialState),
  );
  const [preview, setPreview] = useState<AdministratorRecoveryPreviewAdministrator | null>(
    initialPreview ?? null,
  );
  const [providers, setProviders] = useState<readonly AuthProvider[]>(initialProviders ?? []);
  const [providerState, setProviderState] = useState<"loading" | "ready" | "unavailable">(
    initialProviders ? "ready" : "loading",
  );
  const [step, setStep] = useState<CeremonyStep>(initialPreview ? initialStep : "preview");
  const [confirmation, setConfirmation] = useState(initialConfirmation);
  const [method, setMethod] = useState<ProofMethod>(() => {
    if (!initialProviders) return initialMethod;
    const methods = availableProofMethods(initialProviders);
    return methods.includes(initialMethod) ? initialMethod : (methods[0] ?? initialMethod);
  });
  const [notice, setNotice] = useState<NoticeState | null>(() =>
    initialNoticeState(initialPreview, initialState, initialNotice),
  );
  const [retryAfter, setRetryAfter] = useState<number | undefined>();
  const [operation, setOperation] = useState<OperationState>(
    initialQuickConnectTransaction ? "quick_pending" : "idle",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [quickConnectTransaction, setQuickConnectTransaction] =
    useState<JellyfinQuickConnectInitiationResponse | null>(initialQuickConnectTransaction ?? null);
  const [announcement, setAnnouncement] = useState("");
  const [focusVersion, setFocusVersion] = useState(0);
  const headingReference = useRef<HTMLHeadingElement>(null);
  const passwordReference = useRef<HTMLInputElement>(null);
  const confirmationReference = useRef<HTMLInputElement>(null);
  const methodReferences = useRef<Partial<Record<ProofMethod, HTMLButtonElement | null>>>({});
  const requestGeneration = useRef(0);
  const completionHandled = useRef(false);
  const restorePasswordFocus = useRef(false);

  const oidcProviders = useMemo(
    () =>
      providers.filter(
        (provider): provider is Extract<AuthProvider, { kind: "oidc" }> =>
          provider.kind === "oidc" && provider.state === "available",
      ),
    [providers],
  );
  const availableMethods = useMemo(() => availableProofMethods(providers), [providers]);
  const busy = operation !== "idle";
  const confirmationMatches = confirmation === ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT;

  const requestFocus = useCallback(() => setFocusVersion((version) => version + 1), []);

  const clearProofMaterial = useCallback((clearConfirmation = false) => {
    requestGeneration.current += 1;
    setPassword("");
    if (passwordReference.current) passwordReference.current.value = "";
    setPasswordVisible(false);
    setQuickConnectTransaction(null);
    setOperation("idle");
    setUsername("");
    if (clearConfirmation) setConfirmation("");
  }, []);

  useEffect(() => {
    if (focusVersion === 0) return;
    headingReference.current?.focus();
  }, [focusVersion]);

  useEffect(() => {
    if (!restorePasswordFocus.current || notice === null || method !== "password") return;
    restorePasswordFocus.current = false;
    passwordReference.current?.focus();
  }, [method, notice]);

  useEffect(() => {
    const clearForHistory = () => clearProofMaterial(true);
    window.addEventListener("pagehide", clearForHistory);
    return () => {
      requestGeneration.current += 1;
      window.removeEventListener("pagehide", clearForHistory);
    };
  }, [clearProofMaterial]);

  useEffect(() => {
    if (blockingState !== "success" || completionHandled.current) return;
    completionHandled.current = true;
    onAuthenticated();
  }, [blockingState, onAuthenticated]);

  const loadPreview = useCallback(
    async (preserveNotice = false) => {
      if (!csrfToken) {
        setBlockingState("session_required");
        setAnnouncement("Recovery access has ended.");
        requestFocus();
        return;
      }
      clearProofMaterial(true);
      if (!preserveNotice) setNotice(null);
      setRetryAfter(undefined);
      setPreview(null);
      setBlockingState("loading");
      setProviderState("loading");
      const generation = requestGeneration.current;
      const [previewOutcome, providerOutcome] = await Promise.all([
        client.loadPreview(csrfToken),
        client.loadProviders(),
      ]);
      if (generation !== requestGeneration.current) return;

      if (providerOutcome.status === "ready") {
        setProviders(providerOutcome.providers);
        setMethod((currentMethod) => {
          const methods = availableProofMethods(providerOutcome.providers);
          return methods.includes(currentMethod) ? currentMethod : (methods[0] ?? currentMethod);
        });
        setProviderState("ready");
      } else {
        setProviders([]);
        setProviderState("unavailable");
      }

      if (previewOutcome.status === "available") {
        setPreview(previewOutcome.administrator);
        setStep("preview");
        setBlockingState("ready");
        setAnnouncement("Sole administrator preview ready.");
      } else {
        setRetryAfter(
          "retryAfterSeconds" in previewOutcome ? previewOutcome.retryAfterSeconds : undefined,
        );
        setBlockingState(
          previewOutcome.status === "uncertain" ? "unavailable" : previewOutcome.status,
        );
        setAnnouncement(
          previewOutcome.status === "target_unavailable"
            ? "Administrator replacement is not available."
            : "Administrator recovery could not load the preview.",
        );
      }
      requestFocus();
    },
    [clearProofMaterial, client, csrfToken, requestFocus],
  );

  useEffect(() => {
    if (blockingState !== "loading") return;
    const timeout = window.setTimeout(() => void loadPreview(true), 0);
    return () => window.clearTimeout(timeout);
  }, [blockingState, loadPreview]);

  const reloadProviders = async () => {
    setProviderState("loading");
    const outcome = await client.loadProviders();
    if (outcome.status === "ready") {
      setProviders(outcome.providers);
      setMethod((currentMethod) => {
        const methods = availableProofMethods(outcome.providers);
        return methods.includes(currentMethod) ? currentMethod : (methods[0] ?? currentMethod);
      });
      setProviderState("ready");
      setAnnouncement("Fresh proof methods loaded.");
      return;
    }
    setProviders([]);
    setProviderState("unavailable");
    setAnnouncement("Fresh proof methods remain unavailable.");
  };

  const targetInput = useCallback((): AdministratorRecoveryTargetInput | null => {
    if (!preview || !confirmationMatches) return null;
    return {
      administratorId: preview.id,
      confirmation: ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT,
      expectedUpdatedAt: preview.updatedAt,
    };
  }, [confirmationMatches, preview]);

  const showBlockingFailure = useCallback(
    (failure: Exclude<AdministratorRecoveryFailure, "uncertain">, nextRetryAfter?: number) => {
      if (failure === "stale_target" || failure === "session_required") {
        clearProofMaterial(true);
        setPreview(null);
        setBlockingState(failure);
        setAnnouncement(
          failure === "stale_target"
            ? "The administrator preview is stale. No authority changed."
            : "Recovery access has ended.",
        );
        requestFocus();
        return;
      }
      setOperation("idle");
      setNotice(
        failure === "denied"
          ? "denied"
          : failure === "rate_limited"
            ? "rate_limited"
            : "unavailable",
      );
      setRetryAfter(nextRetryAfter);
      setAnnouncement(
        NOTICE_COPY[
          failure === "denied"
            ? "denied"
            : failure === "rate_limited"
              ? "rate_limited"
              : "unavailable"
        ],
      );
    },
    [clearProofMaterial, requestFocus],
  );

  const verifyAfterMutation = useCallback(
    async (uncertain: boolean) => {
      const generation = requestGeneration.current;
      setOperation("checking_session");
      setAnnouncement("Checking for the normal replacement administrator session.");
      const session = await client.verifySession();
      if (generation !== requestGeneration.current) return;
      if (session === "administrator") {
        clearProofMaterial(true);
        setPreview(null);
        setBlockingState("success");
        setAnnouncement("Administrator access restored. A normal administrator session is active.");
        requestFocus();
        return;
      }
      if (uncertain && session === "recovery") {
        setOperation("idle");
        setNotice("unavailable");
        setAnnouncement(
          "The recovery session is still active. No authority changed, and it is safe to try the proof again.",
        );
        return;
      }
      clearProofMaterial(true);
      setPreview(null);
      setBlockingState("session_unconfirmed");
      setAnnouncement("The normal replacement session could not be confirmed.");
      requestFocus();
    },
    [clearProofMaterial, client, requestFocus],
  );

  const retrySessionCheck = async () => {
    setOperation("checking_session");
    setAnnouncement("Checking the current session again.");
    const session = await client.verifySession();
    if (session === "administrator") {
      clearProofMaterial(true);
      setBlockingState("success");
      setAnnouncement("Administrator access restored. A normal administrator session is active.");
      requestFocus();
      return;
    }
    setOperation("idle");
    setAnnouncement("A normal administrator session is still not available.");
  };

  const beginConfirmation = () => {
    setNotice(null);
    setStep("confirmation");
    setAnnouncement("Confirmation step. Type the displayed phrase exactly.");
    requestFocus();
  };

  const confirmIntent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmationMatches) return;
    setStep("proof");
    setNotice(null);
    setAnnouncement("Choose a fresh identity proof method.");
    requestFocus();
  };

  const returnToStep = (nextStep: "confirmation" | "preview") => {
    clearProofMaterial(nextStep === "preview");
    setNotice(null);
    setStep(nextStep);
    setAnnouncement(
      nextStep === "preview" ? "Returned to administrator preview." : "Returned to confirmation.",
    );
    requestFocus();
  };

  const submitPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = targetInput();
    if (!target || busy || username.trim().length === 0 || password.length === 0 || !csrfToken)
      return;
    const input = { ...target, password, username: username.trim() };
    setPassword("");
    if (passwordReference.current) passwordReference.current.value = "";
    setPasswordVisible(false);
    setNotice(null);
    setOperation("password_submitting");
    setAnnouncement("Verifying the Jellyfin account and current administrator policy.");
    const outcome = await client.replaceWithPassword(input, csrfToken);
    if (outcome.status === "replaced") {
      await verifyAfterMutation(false);
      return;
    }
    if (outcome.status === "uncertain") {
      await verifyAfterMutation(true);
      return;
    }
    restorePasswordFocus.current = true;
    showBlockingFailure(outcome.status, outcome.retryAfterSeconds);
  };

  const startQuickConnect = async () => {
    const target = targetInput();
    if (!target || busy || !csrfToken) return;
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setNotice(null);
    setQuickConnectTransaction(null);
    setOperation("quick_starting");
    setAnnouncement("Requesting a fresh Jellyfin Quick Connect code.");
    const outcome = await client.startQuickConnect(target, csrfToken);
    if (generation !== requestGeneration.current) return;
    if (outcome.status === "started") {
      setQuickConnectTransaction(outcome.transaction);
      setOperation("quick_pending");
      setAnnouncement("Quick Connect code ready. Waiting for approval in Jellyfin.");
      return;
    }
    if (outcome.status === "uncertain") {
      await verifyAfterMutation(true);
      return;
    }
    showBlockingFailure(outcome.status, outcome.retryAfterSeconds);
  };

  useEffect(() => {
    if (
      operation !== "quick_pending" ||
      !quickConnectTransaction ||
      !autoPollQuickConnect ||
      !csrfToken
    ) {
      return;
    }
    const generation = requestGeneration.current;
    const transaction = quickConnectTransaction;
    const timeout = window.setTimeout(async () => {
      const outcome = await client.pollQuickConnect(transaction.transactionId, csrfToken);
      if (generation !== requestGeneration.current) return;
      if (outcome.status === "pending") {
        setQuickConnectTransaction({
          ...transaction,
          expiresAt: outcome.expiresAt,
          pollAfterMs: outcome.pollAfterMs,
        });
        return;
      }
      if (outcome.status === "replaced") {
        await verifyAfterMutation(false);
        return;
      }
      setQuickConnectTransaction(null);
      if (outcome.status === "expired") {
        setOperation("idle");
        setNotice("unavailable");
        setAnnouncement("The Quick Connect code expired. No authority changed.");
        return;
      }
      if (outcome.status === "uncertain") {
        await verifyAfterMutation(true);
        return;
      }
      showBlockingFailure(
        outcome.status,
        "retryAfterSeconds" in outcome ? outcome.retryAfterSeconds : undefined,
      );
    }, transaction.pollAfterMs);
    return () => window.clearTimeout(timeout);
  }, [
    autoPollQuickConnect,
    client,
    csrfToken,
    operation,
    quickConnectTransaction,
    showBlockingFailure,
    verifyAfterMutation,
  ]);

  const selectMethod = (nextMethod: ProofMethod, focus = true) => {
    if (!availableMethods.includes(nextMethod)) return;
    clearProofMaterial(false);
    setNotice(null);
    setMethod(nextMethod);
    setAnnouncement(
      nextMethod === "password"
        ? "Jellyfin password proof selected."
        : nextMethod === "quick-connect"
          ? "Jellyfin Quick Connect proof selected."
          : "Existing-account OIDC proof selected.",
    );
    if (focus) queueMicrotask(() => methodReferences.current[nextMethod]?.focus());
  };

  const handleMethodKey = (event: KeyboardEvent<HTMLButtonElement>, currentMethod: ProofMethod) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = availableMethods.indexOf(currentMethod);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? availableMethods.length - 1
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + availableMethods.length) % availableMethods.length
            : (currentIndex + 1) % availableMethods.length;
    const nextMethod = availableMethods[nextIndex];
    if (nextMethod) selectMethod(nextMethod);
  };

  const startOidc = async (providerId: string) => {
    const target = targetInput();
    if (!target || busy || !csrfToken) return;
    setNotice(null);
    setOperation("oidc_starting");
    setAnnouncement("Starting a fresh identity-provider authorization.");
    const outcome = await client.startOidc(providerId, target, csrfToken);
    if (outcome.status === "started") {
      clearProofMaterial(true);
      window.history.replaceState(window.history.state, "", "/recovery");
      onOidcRedirect(outcome.authorization.authorizationUrl);
      return;
    }
    if (outcome.status === "uncertain") {
      setOperation("idle");
      setNotice("unavailable");
      setAnnouncement(
        "The identity-provider redirect did not start. No authority changed, and it is safe to try again.",
      );
      return;
    }
    showBlockingFailure(outcome.status, outcome.retryAfterSeconds);
  };

  const stepNumber =
    blockingState === "success" ? 4 : step === "preview" ? 1 : step === "confirmation" ? 2 : 3;

  const blockingPanel =
    blockingState !== "ready" ? (
      <div
        aria-live={
          blockingState === "loading" || blockingState === "success" ? "polite" : "assertive"
        }
        className={styles.statePanel}
        data-state={blockingState}
        role={blockingState === "loading" || blockingState === "success" ? "status" : "alert"}
      >
        <span className={styles.stateIcon} aria-hidden="true">
          {blockingState === "loading" || operation === "checking_session" ? (
            <LoaderCircle className="jellyfin-login-form__spinner" size={28} />
          ) : blockingState === "success" ? (
            <Check size={28} />
          ) : (
            <TriangleAlert size={28} />
          )}
        </span>
        <div>
          <p className="section-kicker">
            {blockingState === "success" ? "Normal session established" : "Recovery boundary"}
          </p>
          <h2 ref={headingReference} tabIndex={-1}>
            {blockingState === "loading"
              ? "Checking for a sole administrator"
              : blockingState === "success"
                ? "Administrator access restored"
                : BLOCKING_COPY[blockingState].title}
          </h2>
          <p>
            {blockingState === "loading"
              ? "OmniFin is requesting a no-store preview. Account details remain hidden unless one exact replacement target is available."
              : blockingState === "success"
                ? "A normal replacement administrator session is active. Opening OmniFin now."
                : BLOCKING_COPY[blockingState].body}
          </p>
          {blockingState === "rate_limited" && retryAfter ? (
            <p className={styles.retryNote}>
              The server requested a wait of at least {retryAfter} seconds.
            </p>
          ) : null}
        </div>
        {blockingState !== "loading" && blockingState !== "success" ? (
          <div className={styles.stateActions}>
            {blockingState === "session_unconfirmed" ? (
              <>
                <button
                  className="jellyfin-login-form__submit"
                  disabled={operation === "checking_session"}
                  onClick={retrySessionCheck}
                  type="button"
                >
                  {operation === "checking_session" ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="jellyfin-login-form__spinner"
                      size={18}
                    />
                  ) : (
                    <RefreshCw aria-hidden="true" size={17} />
                  )}
                  Check current session
                </button>
                <Link className={styles.secondaryAction} href="/login">
                  Return to sign in
                </Link>
              </>
            ) : blockingState === "session_required" || blockingState === "denied" ? (
              <Link className="jellyfin-login-form__submit" href="/recovery">
                Open recovery access again
                <ArrowRight aria-hidden="true" size={18} />
              </Link>
            ) : (
              <>
                <button
                  className="jellyfin-login-form__submit"
                  onClick={() => void loadPreview()}
                  type="button"
                >
                  Load a fresh preview
                  <RefreshCw aria-hidden="true" size={17} />
                </button>
                {blockingState === "target_unavailable" && onFirstAdministratorSetup ? (
                  <button
                    className={styles.secondaryAction}
                    onClick={onFirstAdministratorSetup}
                    type="button"
                  >
                    New installation: establish first administrator
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <div className={`jellyfin-login-layout ${styles.layout}`} data-display-profile={displayProfile}>
      <CinematicBackdrop />
      <main
        aria-busy={blockingState === "loading" || busy}
        className={`jellyfin-login-card ${styles.card}`}
        id="main-content"
        tabIndex={-1}
      >
        <section
          className={`jellyfin-login-card__intro ${styles.intro}`}
          aria-labelledby="administrator-recovery-title"
        >
          <BrandMark />
          <Link className="jellyfin-login-card__back" href="/">
            <ArrowLeft aria-hidden="true" size={16} />
            Exit recovery
          </Link>
          <div className={`jellyfin-login-card__headline ${styles.headline}`}>
            <p className="eyebrow">Sole administrator recovery</p>
            <h1 id="administrator-recovery-title">Recover administrator access.</h1>
            <p>
              Replace an inaccessible local administrator only after reviewing the exact record and
              proving a different, eligible account.
            </p>
          </div>
          <ol className={styles.progress} aria-label="Administrator recovery progress">
            {[
              [1, "Review local target"],
              [2, "Confirm the change"],
              [3, "Prove replacement account"],
            ].map(([number, label]) => {
              const numericNumber = Number(number);
              const complete = stepNumber > numericNumber;
              const current = stepNumber === numericNumber;
              return (
                <li
                  aria-current={current ? "step" : undefined}
                  data-complete={complete || undefined}
                  data-current={current || undefined}
                  key={numericNumber}
                >
                  <span aria-hidden="true">{complete ? <Check size={14} /> : numericNumber}</span>
                  {label}
                </li>
              );
            })}
          </ol>
          <ul
            className={`jellyfin-login-card__assurances ${styles.assurances}`}
            aria-label="Replacement safeguards"
          >
            <li>
              <LockKeyhole aria-hidden="true" size={17} />
              Exact local account revision checked again at commit
            </li>
            <li>
              <ShieldCheck aria-hidden="true" size={17} />
              Previous, replacement, and recovery sessions are revoked
            </li>
            <li>
              <KeyRound aria-hidden="true" size={17} />
              Password and proof transaction material are not retained here
            </li>
          </ul>
        </section>

        <section
          className={`jellyfin-login-card__form-panel ${styles.panel}`}
          aria-label="Administrator replacement ceremony"
        >
          <span className="sr-only" aria-atomic="true" aria-live="polite">
            {announcement}
          </span>
          {blockingPanel}

          {blockingState === "ready" && preview && step === "preview" ? (
            <div className={styles.stepPanel}>
              <span className="jellyfin-login-card__method-icon" aria-hidden="true">
                <ShieldCheck size={22} />
              </span>
              <div className="jellyfin-login-card__form-heading">
                <p className="section-kicker">Step 1 of 3 · Local target</p>
                <h2 ref={headingReference} tabIndex={-1}>
                  Review the authority change
                </h2>
                <p>
                  Only this revision can be replaced. OmniFin checks it again before committing.
                </p>
              </div>
              {notice ? (
                <div className={styles.notice} data-kind={notice} role="alert">
                  <TriangleAlert aria-hidden="true" size={18} />
                  <p>{NOTICE_COPY[notice]}</p>
                </div>
              ) : null}
              <article className={styles.targetCard} aria-labelledby="recovery-target-name">
                <div>
                  <p>Local administrator</p>
                  <h3 id="recovery-target-name">{preview.displayName}</h3>
                </div>
                <dl>
                  <div>
                    <dt>Active OmniFin sessions</dt>
                    <dd>{preview.activeSessions}</dd>
                  </div>
                  <div>
                    <dt>Local sign-in methods</dt>
                    <dd>
                      {preview.authenticationMethods.length > 0
                        ? preview.authenticationMethods.map(authenticationMethodLabel).join(" · ")
                        : "None reported"}
                    </dd>
                  </div>
                  <div>
                    <dt>Record revision</dt>
                    <dd>
                      <time dateTime={preview.updatedAt}>
                        {formattedRevision(preview.updatedAt)}
                      </time>
                    </dd>
                  </div>
                </dl>
              </article>
              <section className={styles.localWarning} aria-labelledby="local-authority-warning">
                <TriangleAlert aria-hidden="true" size={20} />
                <div>
                  <h3 id="local-authority-warning">Only OmniFin authority is replaced</h3>
                  <p>
                    The shown local account is disabled and its OmniFin sessions are revoked. Its
                    Jellyfin and identity-provider accounts, passwords, roles, and sessions remain
                    unchanged.
                  </p>
                </div>
              </section>
              <button
                className="jellyfin-login-form__submit"
                onClick={beginConfirmation}
                type="button"
              >
                Continue to confirmation
                <ArrowRight aria-hidden="true" size={18} />
              </button>
            </div>
          ) : null}

          {blockingState === "ready" && preview && step === "confirmation" ? (
            <div className={styles.stepPanel}>
              <button
                className={styles.inlineBack}
                onClick={() => returnToStep("preview")}
                type="button"
              >
                <ArrowLeft aria-hidden="true" size={16} />
                Back to preview
              </button>
              <span className="jellyfin-login-card__method-icon" aria-hidden="true">
                <TriangleAlert size={22} />
              </span>
              <div className="jellyfin-login-card__form-heading">
                <p className="section-kicker">Step 2 of 3 · Explicit confirmation</p>
                <h2 ref={headingReference} tabIndex={-1}>
                  Confirm this exact revision
                </h2>
                <p>
                  This confirmation is bound to {preview.displayName} as recorded at{" "}
                  <time dateTime={preview.updatedAt}>{formattedRevision(preview.updatedAt)}</time>.
                </p>
              </div>
              <div className={styles.confirmationPhrase}>
                <span>Type this phrase exactly</span>
                <code>{ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT}</code>
              </div>
              <form className="jellyfin-login-form" onSubmit={confirmIntent}>
                <label className="jellyfin-login-field">
                  <span>Confirmation phrase</span>
                  <input
                    aria-describedby="administrator-confirmation-help"
                    autoCapitalize="none"
                    autoComplete="off"
                    maxLength={ADMINISTRATOR_RECOVERY_CONFIRMATION_TEXT.length}
                    onChange={(event) => setConfirmation(event.currentTarget.value)}
                    ref={confirmationReference}
                    spellCheck={false}
                    type="text"
                    value={confirmation}
                  />
                </label>
                <p className={styles.fieldHelp} id="administrator-confirmation-help">
                  Punctuation is not required. Capitalization and spacing must match.
                </p>
                <button
                  className="jellyfin-login-form__submit"
                  disabled={!confirmationMatches}
                  type="submit"
                >
                  Choose fresh identity proof
                  <ArrowRight aria-hidden="true" size={18} />
                </button>
              </form>
            </div>
          ) : null}

          {blockingState === "ready" && preview && step === "proof" ? (
            <div className={styles.stepPanel}>
              <button
                className={styles.inlineBack}
                onClick={() => returnToStep("confirmation")}
                type="button"
              >
                <ArrowLeft aria-hidden="true" size={16} />
                Back to confirmation
              </button>
              <span className="jellyfin-login-card__method-icon" aria-hidden="true">
                <ProofIcon method={method} />
              </span>
              <div className="jellyfin-login-card__form-heading">
                <p className="section-kicker">Step 3 of 3 · Fresh proof</p>
                <h2 ref={headingReference} tabIndex={-1}>
                  Prove the replacement account
                </h2>
                <p>
                  Use a different, existing OmniFin account. The proof must still satisfy current
                  upstream administrator policy.
                </p>
              </div>

              {providerState === "loading" ? (
                <div className={styles.methodGate} role="status">
                  <LoaderCircle
                    aria-hidden="true"
                    className="jellyfin-login-form__spinner"
                    size={22}
                  />
                  Loading fresh proof methods…
                </div>
              ) : providerState === "unavailable" || availableMethods.length === 0 ? (
                <div className={styles.methodGate} role="alert">
                  <TriangleAlert aria-hidden="true" size={22} />
                  <div>
                    <strong>No fresh proof method is available</strong>
                    <p>
                      OmniFin could not load an available Jellyfin or OIDC method. The confirmed
                      target has not changed.
                    </p>
                  </div>
                  <button
                    className={styles.secondaryAction}
                    onClick={reloadProviders}
                    type="button"
                  >
                    Try method check again
                  </button>
                </div>
              ) : (
                <>
                  <div
                    className={styles.methods}
                    role="tablist"
                    aria-label="Fresh identity proof method"
                  >
                    {availableMethods.map((availableMethod) => (
                      <button
                        aria-controls={`administrator-${availableMethod}-panel`}
                        aria-selected={method === availableMethod}
                        id={`administrator-${availableMethod}-tab`}
                        key={availableMethod}
                        onClick={() => selectMethod(availableMethod, false)}
                        onKeyDown={(event) => handleMethodKey(event, availableMethod)}
                        ref={(node) => {
                          methodReferences.current[availableMethod] = node;
                        }}
                        role="tab"
                        tabIndex={method === availableMethod ? 0 : -1}
                        type="button"
                      >
                        <ProofIcon method={availableMethod} />
                        {availableMethod === "password"
                          ? "Jellyfin password"
                          : availableMethod === "quick-connect"
                            ? "Quick Connect"
                            : "Existing-account OIDC"}
                      </button>
                    ))}
                  </div>

                  {notice ? (
                    <div className={styles.notice} data-kind={notice} role="alert">
                      <TriangleAlert aria-hidden="true" size={18} />
                      <div>
                        <p>{NOTICE_COPY[notice]}</p>
                        {notice === "rate_limited" && retryAfter ? (
                          <p>Wait at least {retryAfter} seconds before sending another proof.</p>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {method === "password" ? (
                    <div
                      aria-labelledby="administrator-password-tab"
                      id="administrator-password-panel"
                      role="tabpanel"
                    >
                      <form
                        aria-busy={
                          operation === "password_submitting" || operation === "checking_session"
                        }
                        className="jellyfin-login-form"
                        onSubmit={submitPassword}
                      >
                        <label className="jellyfin-login-field">
                          <span>Jellyfin username</span>
                          <input
                            autoCapitalize="none"
                            autoComplete="username"
                            disabled={busy}
                            maxLength={160}
                            onChange={(event) => setUsername(event.currentTarget.value)}
                            required
                            spellCheck={false}
                            type="text"
                            value={username}
                          />
                        </label>
                        <div className="jellyfin-login-field">
                          <label htmlFor="administrator-recovery-password">Jellyfin password</label>
                          <span className="jellyfin-login-field__password">
                            <input
                              autoComplete="current-password"
                              disabled={busy}
                              id="administrator-recovery-password"
                              maxLength={1_024}
                              onChange={(event) => setPassword(event.currentTarget.value)}
                              ref={passwordReference}
                              required
                              type={passwordVisible ? "text" : "password"}
                              value={password}
                            />
                            <button
                              aria-label={passwordVisible ? "Hide password" : "Show password"}
                              className="jellyfin-login-field__reveal"
                              disabled={busy}
                              onClick={() => setPasswordVisible((visible) => !visible)}
                              type="button"
                            >
                              {passwordVisible ? (
                                <EyeOff aria-hidden="true" size={18} />
                              ) : (
                                <Eye aria-hidden="true" size={18} />
                              )}
                            </button>
                          </span>
                        </div>
                        <p className={styles.fieldHelp}>
                          Jellyfin verifies these credentials live. The account must already be
                          linked to a different active OmniFin account.
                        </p>
                        <button
                          className="jellyfin-login-form__submit"
                          disabled={busy}
                          type="submit"
                        >
                          {operation === "password_submitting" ||
                          operation === "checking_session" ? (
                            <>
                              <LoaderCircle
                                aria-hidden="true"
                                className="jellyfin-login-form__spinner"
                                size={18}
                              />
                              {operation === "checking_session"
                                ? "Confirming normal session"
                                : "Verifying and replacing"}
                            </>
                          ) : (
                            <>
                              Replace local administrator
                              <ArrowRight aria-hidden="true" size={18} />
                            </>
                          )}
                        </button>
                      </form>
                    </div>
                  ) : method === "quick-connect" ? (
                    <div
                      aria-labelledby="administrator-quick-connect-tab"
                      className={styles.proofPanel}
                      id="administrator-quick-connect-panel"
                      role="tabpanel"
                    >
                      {quickConnectTransaction ? (
                        <div className={styles.quickConnectPending}>
                          <div className={styles.quickCode}>
                            <span>One-time Jellyfin code</span>
                            <output aria-label="Administrator recovery Quick Connect code">
                              {quickConnectTransaction.code}
                            </output>
                          </div>
                          <ol>
                            <li>
                              Open Jellyfin on a device where the replacement account is signed in.
                            </li>
                            <li>Choose Quick Connect and enter the code.</li>
                            <li>
                              Approve, then leave this page open while OmniFin checks the result.
                            </li>
                          </ol>
                          <div className={styles.pendingStatus} role="status">
                            <span aria-hidden="true" />
                            <span>Waiting for Jellyfin approval</span>
                            <time dateTime={quickConnectTransaction.expiresAt}>
                              Expires {formattedRevision(quickConnectTransaction.expiresAt)}
                            </time>
                          </div>
                          <button
                            className={styles.secondaryAction}
                            onClick={() => selectMethod("quick-connect", false)}
                            type="button"
                          >
                            Cancel this code
                          </button>
                        </div>
                      ) : (
                        <div className={styles.quickConnectStart}>
                          <span aria-hidden="true">
                            {operation === "quick_starting" ? (
                              <LoaderCircle className="jellyfin-login-form__spinner" size={30} />
                            ) : (
                              <Smartphone size={30} />
                            )}
                          </span>
                          <p>
                            Generate a short-lived code, then approve it as a Jellyfin administrator
                            already linked to a different active OmniFin account.
                          </p>
                          <button
                            className="jellyfin-login-form__submit"
                            disabled={busy}
                            onClick={startQuickConnect}
                            type="button"
                          >
                            {operation === "quick_starting" ? (
                              <>
                                <LoaderCircle
                                  aria-hidden="true"
                                  className="jellyfin-login-form__spinner"
                                  size={18}
                                />
                                Generating fresh code
                              </>
                            ) : (
                              <>
                                Generate Quick Connect code
                                <RefreshCw aria-hidden="true" size={17} />
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div
                      aria-labelledby="administrator-oidc-tab"
                      className={styles.proofPanel}
                      id="administrator-oidc-panel"
                      role="tabpanel"
                    >
                      <div className={styles.oidcIntro}>
                        <Fingerprint aria-hidden="true" size={24} />
                        <p>
                          Sign in again through a provider below. OmniFin accepts only a distinct,
                          existing active account with a current administrator mapping and usable
                          Jellyfin link. This flow does not create an account.
                        </p>
                      </div>
                      <ul
                        className={styles.oidcProviders}
                        aria-label="Available identity providers"
                      >
                        {oidcProviders.map((provider) => (
                          <li key={provider.id}>
                            <button
                              disabled={busy}
                              onClick={() => startOidc(provider.id)}
                              type="button"
                            >
                              <span>
                                <Fingerprint aria-hidden="true" size={19} />
                                <strong>{provider.displayName}</strong>
                              </span>
                              {operation === "oidc_starting" ? (
                                <LoaderCircle
                                  aria-hidden="true"
                                  className="jellyfin-login-form__spinner"
                                  size={18}
                                />
                              ) : (
                                <ArrowRight aria-hidden="true" size={18} />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
