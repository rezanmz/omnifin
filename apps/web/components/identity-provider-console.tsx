"use client";

import {
  oidcProviderCreateRequestSchema,
  oidcProviderUpdateRequestSchema,
  oidcRoleMappingCreateRequestSchema,
  type OidcProviderAdmin,
  type OidcProviderCapabilities,
  type OidcProviderCreateRequest,
  type OidcProviderUpdateRequest,
  type OidcRoleMappingCreateRequest,
  type RoleMapping,
} from "@omnifin/contracts/auth";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  CloudOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRoundCog,
  UsersRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import type { DisplayProfile } from "../lib/dashboard-data";
import {
  IdentityProviderAdminClientError,
  identityProviderAdminClient,
  type IdentityProviderAdminClient,
  type IdentityProviderAdminLoadOutcome,
} from "../lib/identity-provider-admin";
import styles from "./identity-provider-console.module.css";
import { IdentityProviderPageShell } from "./identity-provider-page-shell";

const administrationQueryKey = ["identity-provider-administration"] as const;
const signingAlgorithms = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
const tokenMethods = ["client_secret_basic", "client_secret_post", "none"] as const;
const roles = ["viewer", "requester", "operator", "admin"] as const;
const mappingOperators = ["equals", "contains_any", "contains_all"] as const;

interface IdentityProviderConsoleProperties {
  client?: IdentityProviderAdminClient;
  displayProfile?: DisplayProfile;
  embedded?: boolean;
  initialMappings?: Readonly<Record<string, readonly RoleMapping[]>> | undefined;
  initialOutcome?: IdentityProviderAdminLoadOutcome | undefined;
  publicBaseUrl: string;
}

interface ProviderFormProperties {
  busy: boolean;
  mode: "create" | "edit";
  onCancel?: (() => void) | undefined;
  onSubmit: (input: OidcProviderCreateRequest | OidcProviderUpdateRequest) => Promise<void>;
  provider?: OidcProviderAdmin | undefined;
  publicBaseUrl: string;
}

interface MappingFormProperties {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: OidcRoleMappingCreateRequest) => Promise<void>;
}

type ProviderFormFields = {
  allowJitProvisioning: boolean;
  clientId: string;
  clientSecret: string;
  displayName: string;
  groupsScope: boolean;
  idTokenSigningAlg: (typeof signingAlgorithms)[number];
  issuer: string;
  slug: string;
  tokenEndpointAuthMethod: (typeof tokenMethods)[number];
};

function providerIdentifier(slug: string) {
  return `oidc-${slug}`;
}

function providerUrls(publicBaseUrl: string, providerId: string) {
  const base = publicBaseUrl.replace(/\/$/u, "");
  return {
    backchannel: `${base}/api/auth/oidc/backchannel/${providerId}`,
    callback: `${base}/api/auth/oidc/callback/${providerId}`,
    frontchannel: `${base}/api/auth/oidc/frontchannel/${providerId}`,
    logout: `${base}/login?loggedOut=1`,
  };
}

function initialProviderFields(provider?: OidcProviderAdmin): ProviderFormFields {
  return {
    allowJitProvisioning: provider?.allowJitProvisioning ?? true,
    clientId: provider?.clientId ?? "",
    clientSecret: "",
    displayName: provider?.displayName ?? "Authentik",
    groupsScope: provider?.scopes.includes("groups") ?? false,
    idTokenSigningAlg: provider?.idTokenSigningAlg ?? "RS256",
    issuer: provider?.issuer ?? "",
    slug: provider?.slug ?? "authentik",
    tokenEndpointAuthMethod: provider?.tokenEndpointAuthMethod ?? "client_secret_basic",
  };
}

function userFacingError(error: unknown) {
  if (error instanceof IdentityProviderAdminClientError) return error.message;
  return "The operation could not be completed. No unconfirmed settings were applied.";
}

function CopyControl({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={styles.endpoint}>
      <div>
        <span>{label}</span>
        <code>{value}</code>
      </div>
      <button aria-label={`Copy ${label}`} onClick={copy} type="button">
        {copied ? (
          <Check aria-hidden="true" size={16} />
        ) : (
          <Clipboard aria-hidden="true" size={16} />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
}

function Field({
  children,
  description,
  error,
  label,
  name,
}: {
  children: React.ReactNode;
  description?: string | undefined;
  error?: string | undefined;
  label: string;
  name: string;
}) {
  return (
    <label className={styles.field} htmlFor={name}>
      <span>{label}</span>
      {children}
      {description ? <small id={`${name}-description`}>{description}</small> : null}
      {error ? (
        <small className={styles.fieldError} id={`${name}-error`} role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}

function ProviderForm({
  busy,
  mode,
  onCancel,
  onSubmit,
  provider,
  publicBaseUrl,
}: ProviderFormProperties) {
  const formId = useId();
  const [fields, setFields] = useState(() => initialProviderFields(provider));
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const providerId = provider?.id ?? providerIdentifier(fields.slug);
  const urls = providerUrls(publicBaseUrl, providerId);

  const update = <Key extends keyof ProviderFormFields>(
    key: Key,
    value: ProviderFormFields[Key],
  ) => {
    setFields((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };

  const next = () => {
    const nextErrors: Record<string, string> = {};
    if (step === 1) {
      if (fields.displayName.trim().length === 0) nextErrors.displayName = "Enter a display name.";
      if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(fields.slug)) {
        nextErrors.slug = "Use lowercase letters, numbers, and single hyphens.";
      }
      try {
        const issuer = new URL(fields.issuer);
        if (issuer.protocol !== "https:")
          nextErrors.issuer = "Use the provider's HTTPS issuer URL.";
      } catch {
        nextErrors.issuer = "Enter the complete issuer URL from Authentik.";
      }
    }
    if (step === 2) {
      if (fields.clientId.trim().length === 0) nextErrors.clientId = "Enter the client ID.";
      if (
        fields.tokenEndpointAuthMethod !== "none" &&
        fields.clientSecret.length === 0 &&
        (mode === "create" || provider?.clientSecretConfigured === false)
      ) {
        nextErrors.clientSecret = "Enter the client secret issued by Authentik.";
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length === 0) setStep((current) => Math.min(3, current + 1));
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let issuerOrigin: string;
    try {
      issuerOrigin = new URL(fields.issuer).origin;
    } catch {
      setErrors({ issuer: "Enter the complete issuer URL from Authentik." });
      setStep(1);
      return;
    }
    const candidate = {
      allowJitProvisioning: fields.allowJitProvisioning,
      approvedEndpointOrigins: [issuerOrigin],
      clientId: fields.clientId,
      ...(fields.clientSecret.length > 0 ? { clientSecret: fields.clientSecret } : {}),
      displayName: fields.displayName,
      enabled: provider?.enabled ?? false,
      idTokenSigningAlg: fields.idTokenSigningAlg,
      issuer: fields.issuer,
      scopes: ["openid", "profile", "email", ...(fields.groupsScope ? ["groups"] : [])],
      slug: fields.slug,
      tokenEndpointAuthMethod: fields.tokenEndpointAuthMethod,
    };
    const schema =
      mode === "create" ? oidcProviderCreateRequestSchema : oidcProviderUpdateRequestSchema;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        fieldErrors[key] ??= issue.message;
      }
      setErrors(fieldErrors);
      if (fieldErrors.displayName || fieldErrors.slug || fieldErrors.issuer) setStep(1);
      else if (fieldErrors.clientId || fieldErrors.clientSecret) setStep(2);
      return;
    }
    await onSubmit(parsed.data);
  };

  return (
    <form className={styles.setup} onSubmit={submit}>
      <div className={styles.workspaceHeading}>
        <div>
          <p className="section-kicker">
            {mode === "create" ? "Guided connection" : "Configuration"}
          </p>
          <h2>{mode === "create" ? "Connect Authentik" : `Edit ${provider?.displayName}`}</h2>
          <p>
            {mode === "create"
              ? "Reserve exact endpoints first, then add client credentials and decide how new identities enter."
              : "Stored secrets stay sealed. Leave the secret blank to keep the current value."}
          </p>
        </div>
        {onCancel ? (
          <button
            className={styles.iconButton}
            aria-label="Close configuration"
            onClick={onCancel}
            type="button"
          >
            <X aria-hidden="true" size={19} />
          </button>
        ) : null}
      </div>

      <ol
        className={styles.steps}
        aria-label={mode === "create" ? "Authentik setup progress" : "Provider editing progress"}
      >
        {["Identity", "Endpoints", "Access"].map((label, index) => {
          const number = index + 1;
          return (
            <li
              data-current={step === number || undefined}
              data-complete={step > number || undefined}
              key={label}
            >
              <span>{step > number ? <Check aria-hidden="true" size={14} /> : number}</span>
              {label}
            </li>
          );
        })}
      </ol>

      <div className={styles.formSurface}>
        {step === 1 ? (
          <div className={styles.formSection}>
            <div className={styles.formSectionHeading}>
              <Fingerprint aria-hidden="true" size={21} />
              <div>
                <h3>Name the trust boundary</h3>
                <p>Use the issuer shown in Authentik&apos;s OpenID configuration.</p>
              </div>
            </div>
            <div className={styles.fieldGrid}>
              <Field
                error={errors.displayName}
                label="Display name"
                name={`${formId}-display-name`}
              >
                <input
                  aria-invalid={Boolean(errors.displayName)}
                  id={`${formId}-display-name`}
                  maxLength={160}
                  onChange={(event) => update("displayName", event.target.value)}
                  value={fields.displayName}
                />
              </Field>
              <Field
                description="Forms the stable callback identifier when this provider is created."
                error={errors.slug}
                label="Slug"
                name={`${formId}-slug`}
              >
                <input
                  aria-invalid={Boolean(errors.slug)}
                  id={`${formId}-slug`}
                  maxLength={64}
                  onChange={(event) => update("slug", event.target.value.toLowerCase())}
                  spellCheck={false}
                  value={fields.slug}
                />
              </Field>
            </div>
            <Field
              description="Example: https://auth.example.com/application/o/omnifin/"
              error={errors.issuer}
              label="Issuer URL"
              name={`${formId}-issuer`}
            >
              <input
                aria-invalid={Boolean(errors.issuer)}
                autoCapitalize="none"
                autoCorrect="off"
                id={`${formId}-issuer`}
                inputMode="url"
                maxLength={2_048}
                onChange={(event) => update("issuer", event.target.value)}
                placeholder="https://auth.example.com/application/o/omnifin/"
                spellCheck={false}
                type="url"
                value={fields.issuer}
              />
            </Field>
          </div>
        ) : step === 2 ? (
          <div className={styles.formSection}>
            <div className={styles.formSectionHeading}>
              <Network aria-hidden="true" size={21} />
              <div>
                <h3>Register exact endpoints</h3>
                <p>Copy these into Authentik before issuing the client credentials.</p>
              </div>
            </div>
            <div className={styles.endpointStack}>
              <CopyControl label="Redirect URI" value={urls.callback} />
              <CopyControl label="Back-channel logout" value={urls.backchannel} />
              <CopyControl label="Front-channel logout" value={urls.frontchannel} />
              <CopyControl label="Post-logout redirect" value={urls.logout} />
            </div>
            <div className={styles.fieldGrid}>
              <Field error={errors.clientId} label="Client ID" name={`${formId}-client-id`}>
                <input
                  aria-invalid={Boolean(errors.clientId)}
                  autoCapitalize="none"
                  autoComplete="off"
                  id={`${formId}-client-id`}
                  maxLength={512}
                  onChange={(event) => update("clientId", event.target.value)}
                  spellCheck={false}
                  value={fields.clientId}
                />
              </Field>
              <Field
                description={
                  mode === "edit" && provider?.clientSecretConfigured
                    ? "Leave blank to keep the sealed secret."
                    : undefined
                }
                error={errors.clientSecret}
                label="Client secret"
                name={`${formId}-client-secret`}
              >
                <input
                  aria-invalid={Boolean(errors.clientSecret)}
                  autoComplete="new-password"
                  disabled={fields.tokenEndpointAuthMethod === "none"}
                  id={`${formId}-client-secret`}
                  maxLength={4_096}
                  onChange={(event) => update("clientSecret", event.target.value)}
                  type="password"
                  value={fields.clientSecret}
                />
              </Field>
              <Field label="Token authentication" name={`${formId}-token-method`}>
                <select
                  id={`${formId}-token-method`}
                  onChange={(event) =>
                    update(
                      "tokenEndpointAuthMethod",
                      event.target.value as ProviderFormFields["tokenEndpointAuthMethod"],
                    )
                  }
                  value={fields.tokenEndpointAuthMethod}
                >
                  {tokenMethods.map((method) => (
                    <option key={method} value={method}>
                      {method.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="ID token algorithm" name={`${formId}-signing-algorithm`}>
                <select
                  id={`${formId}-signing-algorithm`}
                  onChange={(event) =>
                    update(
                      "idTokenSigningAlg",
                      event.target.value as ProviderFormFields["idTokenSigningAlg"],
                    )
                  }
                  value={fields.idTokenSigningAlg}
                >
                  {signingAlgorithms.map((algorithm) => (
                    <option key={algorithm} value={algorithm}>
                      {algorithm}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
        ) : (
          <div className={styles.formSection}>
            <div className={styles.formSectionHeading}>
              <UserRoundCog aria-hidden="true" size={21} />
              <div>
                <h3>Set the entry policy</h3>
                <p>
                  New identities start as viewers. Privilege always requires an explicit mapping.
                </p>
              </div>
            </div>
            <label className={styles.choice}>
              <input
                checked={fields.allowJitProvisioning}
                onChange={(event) => update("allowJitProvisioning", event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>Just-in-time provisioning</strong>
                <small>Create a pending viewer identity after the first valid OIDC sign-in.</small>
              </span>
            </label>
            <label className={styles.choice}>
              <input
                checked={fields.groupsScope}
                onChange={(event) => update("groupsScope", event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>Request Authentik group claims</strong>
                <small>
                  Add the groups scope now, then define exact role mappings after validation.
                </small>
              </span>
            </label>
            <div className={styles.securityNote}>
              <LockKeyhole aria-hidden="true" size={18} />
              <p>
                {mode === "create"
                  ? "The provider is saved disabled. Validate discovery before enabling sign-in."
                  : "Saving an effective change closes OIDC sessions attributed to this provider. Direct Jellyfin sessions stay active."}
              </p>
            </div>
          </div>
        )}
      </div>

      {errors.form ? (
        <p className={styles.formError} role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className={styles.formActions}>
        {step > 1 ? (
          <button
            className={styles.secondaryButton}
            onClick={() => setStep((current) => current - 1)}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} /> Back
          </button>
        ) : onCancel ? (
          <button className={styles.secondaryButton} onClick={onCancel} type="button">
            Cancel
          </button>
        ) : (
          <span />
        )}
        {step < 3 ? (
          <button className={styles.primaryButton} onClick={next} type="button">
            Continue <ArrowRight aria-hidden="true" size={16} />
          </button>
        ) : (
          <button className={styles.primaryButton} disabled={busy} type="submit">
            {busy ? (
              <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
            ) : (
              <Save aria-hidden="true" size={16} />
            )}
            {mode === "create" ? "Save disabled provider" : "Save configuration"}
          </button>
        )}
      </div>
    </form>
  );
}

function MappingForm({ busy, onCancel, onSubmit }: MappingFormProperties) {
  const formId = useId();
  const [claimPath, setClaimPath] = useState("groups");
  const [enabled, setEnabled] = useState(true);
  const [operator, setOperator] = useState<(typeof mappingOperators)[number]>("contains_any");
  const [priority, setPriority] = useState(500);
  const [role, setRole] = useState<(typeof roles)[number]>("operator");
  const [valueType, setValueType] = useState<"boolean" | "number" | "string">("string");
  const [values, setValues] = useState("media-operators");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rawValues = values
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const typedValues = rawValues.map((value) => {
      if (valueType === "number") return Number(value);
      if (valueType === "boolean")
        return value === "true" ? true : value === "false" ? false : value;
      return value;
    });
    const parsed = oidcRoleMappingCreateRequestSchema.safeParse({
      claimPath: claimPath
        .split(".")
        .map((segment) => segment.trim())
        .filter(Boolean),
      enabled,
      operator,
      priority,
      role,
      values: typedValues,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Review the mapping values.");
      return;
    }
    setError(null);
    await onSubmit(parsed.data);
  };

  return (
    <form className={styles.mappingForm} onSubmit={submit}>
      <div className={styles.mappingFormHeading}>
        <div>
          <p className="section-kicker">Exact claim rule</p>
          <h4>Add role mapping</h4>
        </div>
        <button
          className={styles.iconButton}
          aria-label="Close role mapping form"
          onClick={onCancel}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className={styles.fieldGrid}>
        <Field
          description="Dot-separated, for example groups or realm.roles."
          label="Claim path"
          name={`${formId}-claim`}
        >
          <input
            id={`${formId}-claim`}
            onChange={(event) => setClaimPath(event.target.value)}
            value={claimPath}
          />
        </Field>
        <Field label="Operator" name={`${formId}-operator`}>
          <select
            id={`${formId}-operator`}
            onChange={(event) => setOperator(event.target.value as typeof operator)}
            value={operator}
          >
            {mappingOperators.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Omnifin role" name={`${formId}-role`}>
          <select
            id={`${formId}-role`}
            onChange={(event) => setRole(event.target.value as typeof role)}
            value={role}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" name={`${formId}-priority`}>
          <input
            id={`${formId}-priority`}
            max={10_000}
            min={0}
            onChange={(event) => setPriority(event.target.valueAsNumber)}
            type="number"
            value={priority}
          />
        </Field>
        <Field label="Value type" name={`${formId}-value-type`}>
          <select
            id={`${formId}-value-type`}
            onChange={(event) => setValueType(event.target.value as typeof valueType)}
            value={valueType}
          >
            <option value="string">string</option>
            <option value="number">number</option>
            <option value="boolean">boolean</option>
          </select>
        </Field>
      </div>
      <Field
        description="One exact value per line. Values are never coerced by the gateway."
        label="Matching values"
        name={`${formId}-values`}
      >
        <textarea
          id={`${formId}-values`}
          onChange={(event) => setValues(event.target.value)}
          rows={3}
          value={values}
        />
      </Field>
      <label className={styles.inlineChoice}>
        <input
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          type="checkbox"
        />{" "}
        Enable this mapping immediately
      </label>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <button className={styles.secondaryButton} onClick={onCancel} type="button">
          Cancel
        </button>
        <button className={styles.primaryButton} disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
          ) : (
            <Plus aria-hidden="true" size={16} />
          )}{" "}
          Add mapping
        </button>
      </div>
    </form>
  );
}

function ProviderState({ state }: { state: OidcProviderAdmin["discoveryState"] }) {
  const label = state === "ready" ? "Validated" : state === "failed" ? "Attention" : "Not checked";
  return (
    <span className={styles.stateBadge} data-state={state}>
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

function IdentityProviderConsoleContent({
  client,
  initialMappings,
  initialOutcome,
  publicBaseUrl,
}: Required<Pick<IdentityProviderConsoleProperties, "client" | "publicBaseUrl">> &
  Pick<IdentityProviderConsoleProperties, "initialMappings" | "initialOutcome">) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    initialOutcome?.status === "ready" ? (initialOutcome.snapshot.providers[0]?.id ?? null) : null,
  );
  const [view, setView] = useState<"create" | "detail" | "edit">("detail");
  const [mappingComposer, setMappingComposer] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [deletingMappingId, setDeletingMappingId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<OidcProviderCapabilities | null>(null);
  const operation = useMutation({ mutationFn: async (action: () => Promise<void>) => action() });
  const outcomeQuery = useQuery({
    initialData: initialOutcome,
    queryFn: client.load,
    queryKey: administrationQueryKey,
    retry: false,
    staleTime: initialOutcome ? Number.POSITIVE_INFINITY : 30_000,
  });
  const outcome = outcomeQuery.data;
  const providers = outcome?.status === "ready" ? outcome.snapshot.providers : [];
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null;
  const effectiveView = providers.length === 0 ? "create" : view;
  const mappingsQuery = useQuery({
    enabled: outcome?.status === "ready" && selected !== null && effectiveView === "detail",
    initialData: selected ? initialMappings?.[selected.id] : undefined,
    queryFn: () => client.listRoleMappings(selected!.id),
    queryKey: ["oidc-role-mappings", selected?.id],
    retry: false,
    staleTime:
      initialMappings && selected && initialMappings[selected.id]
        ? Number.POSITIVE_INFINITY
        : 15_000,
  });

  const updateProviders = (
    transform: (current: readonly OidcProviderAdmin[]) => readonly OidcProviderAdmin[],
  ) => {
    queryClient.setQueryData<IdentityProviderAdminLoadOutcome>(administrationQueryKey, (current) =>
      current?.status === "ready"
        ? {
            ...current,
            snapshot: { ...current.snapshot, providers: transform(current.snapshot.providers) },
          }
        : current,
    );
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setOperationError(null);
    setNotice(null);
    try {
      await operation.mutateAsync(action);
    } catch (error) {
      setOperationError(userFacingError(error));
      if (error instanceof IdentityProviderAdminClientError && error.kind === "session_changed") {
        queryClient.setQueryData(administrationQueryKey, { status: "signed_out" });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const snapshot = outcome?.status === "ready" ? outcome.snapshot : null;

  const createProvider = async (input: OidcProviderCreateRequest | OidcProviderUpdateRequest) => {
    if (!snapshot) return;
    await run("create", async () => {
      const created = await client.createProvider(
        oidcProviderCreateRequestSchema.parse(input),
        snapshot.csrfToken,
      );
      updateProviders((current) =>
        [...current, created].sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
      );
      setSelectedId(created.id);
      setView("detail");
      setNotice(
        `${created.displayName} was saved disabled. Validate discovery before enabling sign-in.`,
      );
    });
  };

  const editProvider = async (input: OidcProviderCreateRequest | OidcProviderUpdateRequest) => {
    if (!snapshot || !selected) return;
    await run("edit", async () => {
      const result = await client.updateProvider(
        selected.id,
        oidcProviderUpdateRequestSchema.parse(input),
        snapshot.csrfToken,
      );
      updateProviders((current) =>
        current.map((provider) =>
          provider.id === result.provider.id ? result.provider : provider,
        ),
      );
      setView("detail");
      setNotice(
        `Configuration saved. ${result.revokedSessions} OIDC session${result.revokedSessions === 1 ? "" : "s"} closed.`,
      );
    });
  };

  const validate = async () => {
    if (!snapshot || !selected) return;
    await run("validate", async () => {
      const result = await client.validateProvider(selected.id, snapshot.csrfToken);
      updateProviders((current) =>
        current.map((provider) =>
          provider.id === result.provider.id ? result.provider : provider,
        ),
      );
      setCapabilities(result.capabilities);
      setNotice(
        "Discovery, PKCE, signing, token authentication, and advertised logout capabilities passed validation.",
      );
    });
  };

  const toggleEnabled = async () => {
    if (!snapshot || !selected) return;
    await run("toggle", async () => {
      const input = oidcProviderUpdateRequestSchema.parse({
        allowJitProvisioning: selected.allowJitProvisioning,
        approvedEndpointOrigins: [...selected.approvedEndpointOrigins],
        clientId: selected.clientId,
        displayName: selected.displayName,
        enabled: !selected.enabled,
        idTokenSigningAlg: selected.idTokenSigningAlg,
        issuer: selected.issuer,
        scopes: [...selected.scopes],
        slug: selected.slug,
        tokenEndpointAuthMethod: selected.tokenEndpointAuthMethod,
      });
      const result = await client.updateProvider(selected.id, input, snapshot.csrfToken);
      updateProviders((current) =>
        current.map((provider) =>
          provider.id === result.provider.id ? result.provider : provider,
        ),
      );
      setNotice(
        result.provider.enabled
          ? "Sign-in is now enabled for this provider."
          : `Sign-in disabled. ${result.revokedSessions} OIDC session${result.revokedSessions === 1 ? "" : "s"} closed.`,
      );
    });
  };

  const deleteProvider = async () => {
    if (!snapshot || !selected) return;
    await run("delete", async () => {
      const result = await client.deleteProvider(selected.id, snapshot.csrfToken);
      updateProviders((current) =>
        current.filter((provider) => provider.id !== result.deletedProviderId),
      );
      queryClient.removeQueries({ queryKey: ["oidc-role-mappings", selected.id] });
      setSelectedId(null);
      setDeleteConfirmation(false);
      setCapabilities(null);
      setNotice(
        `Provider deleted with ${result.deletedRoleMappings} unbound role mapping${result.deletedRoleMappings === 1 ? "" : "s"}.`,
      );
    });
  };

  const createMapping = async (input: OidcRoleMappingCreateRequest) => {
    if (!snapshot || !selected) return;
    await run("mapping-create", async () => {
      const result = await client.createRoleMapping(selected.id, input, snapshot.csrfToken);
      queryClient.setQueryData<readonly RoleMapping[]>(
        ["oidc-role-mappings", selected.id],
        (current = []) =>
          [...current, result.mapping].sort(
            (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
          ),
      );
      setMappingComposer(false);
      setNotice(
        `Role mapping added. ${result.revokedSessions} role-derived session${result.revokedSessions === 1 ? "" : "s"} closed for reevaluation.`,
      );
    });
  };

  const deleteMapping = async (mappingId: string) => {
    if (!snapshot || !selected) return;
    await run(`mapping-delete-${mappingId}`, async () => {
      const result = await client.deleteRoleMapping(selected.id, mappingId, snapshot.csrfToken);
      queryClient.setQueryData<readonly RoleMapping[]>(
        ["oidc-role-mappings", selected.id],
        (current = []) => current.filter((mapping) => mapping.id !== result.deletedMappingId),
      );
      setDeletingMappingId(null);
      setNotice(
        `Role mapping removed. ${result.revokedSessions} role-derived session${result.revokedSessions === 1 ? "" : "s"} closed for reevaluation.`,
      );
    });
  };

  return (
    <>
      {outcomeQuery.isPending ? (
        <section
          aria-busy="true"
          aria-label="Loading identity provider administration"
          className={styles.console}
        >
          <div className={`${styles.providerRail} ${styles.skeleton}`} />
          <div className={`${styles.workspace} ${styles.skeleton}`} />
        </section>
      ) : outcome?.status === "signed_out" ? (
        <section className={styles.statePanel} role="status">
          <KeyRound aria-hidden="true" size={29} />
          <div>
            <h2>Your administrative session ended.</h2>
            <p>Sign in again before changing identity-provider trust.</p>
          </div>
          <Link className={styles.primaryButton} href="/login">
            Return to sign in <ArrowRight aria-hidden="true" size={16} />
          </Link>
        </section>
      ) : outcome?.status === "forbidden" ? (
        <section className={styles.statePanel} role="alert">
          <LockKeyhole aria-hidden="true" size={29} />
          <div>
            <h2>This control room is restricted.</h2>
            <p>
              An administrator or active recovery session is required. No provider details were
              loaded.
            </p>
          </div>
          <Link className={styles.secondaryButton} href="/settings">
            Back to account
          </Link>
        </section>
      ) : outcome?.status !== "ready" ? (
        <section className={styles.statePanel} role="alert">
          <CloudOff aria-hidden="true" size={29} />
          <div>
            <h2>Identity controls are temporarily offline.</h2>
            <p>No settings were changed. Check the gateway connection and try again.</p>
          </div>
          <button
            className={styles.secondaryButton}
            onClick={() => void outcomeQuery.refetch()}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={16} /> Try again
          </button>
        </section>
      ) : (
        <>
          <div className={styles.announcer} aria-live="polite" aria-atomic="true">
            {notice ?? operationError ?? ""}
          </div>
          {notice ? (
            <div className={styles.notice} role="status">
              <BadgeCheck aria-hidden="true" size={18} />
              <p>{notice}</p>
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice(null)}
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
          ) : null}
          {operationError ? (
            <div className={styles.errorNotice} role="alert">
              <CircleAlert aria-hidden="true" size={18} />
              <p>{operationError}</p>
              <button
                aria-label="Dismiss error"
                onClick={() => setOperationError(null)}
                type="button"
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
          ) : null}
          <section className={styles.console} aria-label="OIDC provider administration">
            <aside className={styles.providerRail}>
              <div className={styles.railHeading}>
                <div>
                  <p className="section-kicker">Trust perimeter</p>
                  <h2>Providers</h2>
                </div>
                <button
                  className={styles.addButton}
                  onClick={() => {
                    setView("create");
                    setDeleteConfirmation(false);
                  }}
                  type="button"
                >
                  <Plus aria-hidden="true" size={17} /> Add
                </button>
              </div>
              {providers.length === 0 ? (
                <div className={styles.railEmpty}>
                  <Sparkles aria-hidden="true" size={22} />
                  <strong>No provider yet</strong>
                  <p>Start with the guided Authentik path.</p>
                </div>
              ) : (
                <ul className={styles.providerList}>
                  {providers.map((provider) => (
                    <li key={provider.id}>
                      <button
                        aria-current={
                          selected?.id === provider.id && effectiveView !== "create"
                            ? "page"
                            : undefined
                        }
                        onClick={() => {
                          setSelectedId(provider.id);
                          setView("detail");
                          setCapabilities(null);
                          setMappingComposer(false);
                          setDeleteConfirmation(false);
                        }}
                        type="button"
                      >
                        <span className={styles.providerMonogram} aria-hidden="true">
                          {provider.displayName[0]}
                        </span>
                        <span>
                          <strong>{provider.displayName}</strong>
                          <small>{provider.enabled ? "Sign-in enabled" : "Sign-in disabled"}</small>
                        </span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.railFooter}>
                <LockKeyhole aria-hidden="true" size={15} />
                <p>Client secrets are encrypted and never returned to this screen.</p>
              </div>
            </aside>

            <section
              className={styles.workspace}
              key={`${effectiveView}-${selected?.id ?? "empty"}`}
            >
              {effectiveView === "create" ? (
                <ProviderForm
                  busy={busyAction === "create"}
                  mode="create"
                  onCancel={providers.length > 0 ? () => setView("detail") : undefined}
                  onSubmit={createProvider}
                  publicBaseUrl={publicBaseUrl}
                />
              ) : effectiveView === "edit" && selected ? (
                <ProviderForm
                  busy={busyAction === "edit"}
                  key={selected.id}
                  mode="edit"
                  onCancel={() => setView("detail")}
                  onSubmit={editProvider}
                  provider={selected}
                  publicBaseUrl={publicBaseUrl}
                />
              ) : selected ? (
                <div className={styles.detail}>
                  <div className={styles.workspaceHeading}>
                    <div>
                      <p className="section-kicker">Provider detail</p>
                      <h2>{selected.displayName}</h2>
                      <p>{selected.issuer}</p>
                    </div>
                    <ProviderState state={selected.discoveryState} />
                  </div>

                  <div className={styles.telemetryGrid}>
                    <div>
                      <span>Sign-in</span>
                      <strong>{selected.enabled ? "Enabled" : "Disabled"}</strong>
                      <small>
                        {selected.allowJitProvisioning
                          ? "JIT viewers allowed"
                          : "Known identities only"}
                      </small>
                    </div>
                    <div>
                      <span>Protocol</span>
                      <strong>Code + PKCE</strong>
                      <small>
                        {selected.idTokenSigningAlg} ·{" "}
                        {selected.tokenEndpointAuthMethod.replaceAll("_", " ")}
                      </small>
                    </div>
                    <div>
                      <span>Discovery</span>
                      <strong>{selected.discoveryState}</strong>
                      <small>
                        {selected.discoveryCheckedAt
                          ? new Intl.DateTimeFormat("en", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(new Date(selected.discoveryCheckedAt))
                          : "Never validated"}
                      </small>
                    </div>
                  </div>

                  <section
                    className={styles.detailSection}
                    aria-labelledby="provider-endpoints-title"
                  >
                    <div className={styles.sectionHeading}>
                      <div>
                        <Network aria-hidden="true" size={19} />
                        <span>
                          <h3 id="provider-endpoints-title">Exact provider endpoints</h3>
                          <p>Keep these exact; wildcard redirects are unnecessary.</p>
                        </span>
                      </div>
                    </div>
                    <div className={styles.endpointStack}>
                      {Object.entries(providerUrls(publicBaseUrl, selected.id)).map(
                        ([label, value]) => (
                          <CopyControl
                            key={label}
                            label={
                              label === "callback"
                                ? "Redirect URI"
                                : label === "logout"
                                  ? "Post-logout redirect"
                                  : label.replace("channel", "channel logout")
                            }
                            value={value}
                          />
                        ),
                      )}
                    </div>
                  </section>

                  <div className={styles.lifecycleActions}>
                    <button
                      className={styles.primaryButton}
                      disabled={busyAction !== null}
                      onClick={validate}
                      type="button"
                    >
                      {busyAction === "validate" ? (
                        <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
                      ) : (
                        <ShieldCheck aria-hidden="true" size={16} />
                      )}{" "}
                      Validate now
                    </button>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setView("edit")}
                      type="button"
                    >
                      <Braces aria-hidden="true" size={16} /> Edit configuration
                    </button>
                    <button
                      className={selected.enabled ? styles.dangerButton : styles.primaryButton}
                      disabled={
                        busyAction !== null ||
                        (!selected.enabled && selected.discoveryState !== "ready")
                      }
                      onClick={toggleEnabled}
                      type="button"
                    >
                      {busyAction === "toggle" ? (
                        <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
                      ) : selected.enabled ? (
                        <LockKeyhole aria-hidden="true" size={16} />
                      ) : (
                        <BadgeCheck aria-hidden="true" size={16} />
                      )}
                      {selected.enabled ? "Disable sign-in" : "Enable sign-in"}
                    </button>
                  </div>
                  {!selected.enabled && selected.discoveryState !== "ready" ? (
                    <p className={styles.actionHint}>
                      Validation must pass before this interface enables sign-in.
                    </p>
                  ) : null}

                  {capabilities ? (
                    <section
                      className={styles.capabilities}
                      aria-label="Validated OIDC capabilities"
                    >
                      <div>
                        <Check aria-hidden="true" size={15} /> PKCE S256
                      </div>
                      <div>
                        <Check aria-hidden="true" size={15} /> Authorization code
                      </div>
                      <div>
                        <Check aria-hidden="true" size={15} />{" "}
                        {capabilities.userInfo ? "UserInfo" : "ID token claims"}
                      </div>
                      <div>
                        <Check aria-hidden="true" size={15} />{" "}
                        {Object.values(capabilities.logout).some(Boolean)
                          ? "Provider logout"
                          : "Local logout"}
                      </div>
                    </section>
                  ) : null}

                  <section className={styles.detailSection} aria-labelledby="role-mapping-title">
                    <div className={styles.sectionHeading}>
                      <div>
                        <UsersRound aria-hidden="true" size={19} />
                        <span>
                          <h3 id="role-mapping-title">Role mappings</h3>
                          <p>
                            Exact typed claims, highest priority first. Ambiguous top matches deny
                            sign-in.
                          </p>
                        </span>
                      </div>
                      <button
                        className={styles.addButton}
                        onClick={() => setMappingComposer(true)}
                        type="button"
                      >
                        <Plus aria-hidden="true" size={16} /> Add rule
                      </button>
                    </div>
                    {mappingComposer ? (
                      <MappingForm
                        busy={busyAction === "mapping-create"}
                        onCancel={() => setMappingComposer(false)}
                        onSubmit={createMapping}
                      />
                    ) : null}
                    {mappingsQuery.isPending ? (
                      <div className={styles.mappingLoading} aria-busy="true">
                        Loading role mappings…
                      </div>
                    ) : mappingsQuery.isError ? (
                      <div className={styles.inlineError}>
                        <CircleAlert aria-hidden="true" size={17} /> Role mappings could not be
                        loaded.{" "}
                        <button onClick={() => void mappingsQuery.refetch()} type="button">
                          Try again
                        </button>
                      </div>
                    ) : mappingsQuery.data?.length ? (
                      <ul className={styles.mappingList}>
                        {mappingsQuery.data.map((mapping) => (
                          <li key={mapping.id}>
                            <div className={styles.mappingIcon}>
                              <Braces aria-hidden="true" size={18} />
                            </div>
                            <div>
                              <strong>{mapping.claimPath.join(".")}</strong>
                              <small>
                                {mapping.operator.replaceAll("_", " ")} ·{" "}
                                {mapping.values.map(String).join(", ")}
                              </small>
                            </div>
                            <span className={styles.roleBadge}>{mapping.role}</span>
                            <span className={styles.priority}>P{mapping.priority}</span>
                            {deletingMappingId === mapping.id ? (
                              <div
                                className={styles.mappingConfirm}
                                role="group"
                                aria-label={`Remove ${mapping.claimPath.join(".")} mapping`}
                              >
                                <span>Remove?</span>
                                <button onClick={() => setDeletingMappingId(null)} type="button">
                                  Keep
                                </button>
                                <button
                                  disabled={busyAction !== null}
                                  onClick={() => void deleteMapping(mapping.id)}
                                  type="button"
                                >
                                  Remove
                                </button>
                              </div>
                            ) : (
                              <button
                                className={styles.iconButton}
                                aria-label={`Remove ${mapping.claimPath.join(".")} mapping`}
                                onClick={() => setDeletingMappingId(mapping.id)}
                                type="button"
                              >
                                <Trash2 aria-hidden="true" size={16} />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className={styles.mappingEmpty}>
                        <UsersRound aria-hidden="true" size={21} />
                        <div>
                          <strong>Viewer by default</strong>
                          <p>No claim can grant privilege until an explicit mapping is added.</p>
                        </div>
                      </div>
                    )}
                  </section>

                  <section className={styles.dangerZone} aria-labelledby="provider-danger-title">
                    <div>
                      <p className="section-kicker">Restricted action</p>
                      <h3 id="provider-danger-title">Delete provider</h3>
                      <p>
                        Deletion is available only while disabled and no external identity depends
                        on this issuer.
                      </p>
                    </div>
                    {deleteConfirmation ? (
                      <div
                        className={styles.deleteConfirm}
                        role="group"
                        aria-label="Confirm provider deletion"
                      >
                        <button
                          className={styles.secondaryButton}
                          onClick={() => setDeleteConfirmation(false)}
                          type="button"
                        >
                          Keep provider
                        </button>
                        <button
                          className={styles.dangerButton}
                          disabled={busyAction !== null}
                          onClick={deleteProvider}
                          type="button"
                        >
                          {busyAction === "delete" ? (
                            <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
                          ) : (
                            <Trash2 aria-hidden="true" size={16} />
                          )}{" "}
                          Delete permanently
                        </button>
                      </div>
                    ) : (
                      <button
                        className={styles.dangerButton}
                        disabled={selected.enabled}
                        onClick={() => setDeleteConfirmation(true)}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={16} /> Delete
                      </button>
                    )}
                  </section>
                </div>
              ) : null}
            </section>
          </section>
        </>
      )}
    </>
  );
}

export function IdentityProviderConsole({
  client = identityProviderAdminClient,
  displayProfile = "standard",
  embedded = false,
  initialMappings,
  initialOutcome,
  publicBaseUrl,
}: IdentityProviderConsoleProperties) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          mutations: { retry: false },
          queries: { refetchOnWindowFocus: false, retry: false },
        },
      }),
  );
  const stableClient = useMemo(() => client, [client]);
  const administration = (
    <QueryClientProvider client={queryClient}>
      <IdentityProviderConsoleContent
        client={stableClient}
        initialMappings={initialMappings}
        initialOutcome={initialOutcome}
        publicBaseUrl={publicBaseUrl}
      />
    </QueryClientProvider>
  );
  return embedded ? (
    administration
  ) : (
    <IdentityProviderPageShell displayProfile={displayProfile}>
      {administration}
    </IdentityProviderPageShell>
  );
}
