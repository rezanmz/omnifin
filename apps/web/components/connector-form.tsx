"use client";

import "../lib/zod-browser";

import {
  connectorCreateRequestSchema,
  connectorUpdateRequestSchema,
  type ConnectorAdmin,
  type ConnectorCreateRequest,
  type ConnectorCredentialInput,
  type ConnectorUpdateRequest,
  type ManagedConnectorService,
} from "@omnifin/contracts/connectors";
import { Fingerprint, LoaderCircle, LockKeyhole, Plus, Save } from "lucide-react";
import { useId, useState } from "react";

import styles from "./connector-control-room.module.css";
import { connectorServicePresentation, connectorServices } from "./connector-presentation";

export interface ConnectorFormProperties {
  busy: boolean;
  connector?: ConnectorAdmin | undefined;
  mode: "create" | "edit";
  onCancel?: (() => void) | undefined;
  onSubmit: (input: ConnectorCreateRequest | ConnectorUpdateRequest) => Promise<void>;
  recoveryOnly: boolean;
}

interface FormFields {
  apiKey: string;
  authKind: "api_key" | "none" | "username_password";
  baseUrl: string;
  displayName: string;
  id: string;
  insecureHttpApproved: boolean;
  password: string;
  service: ManagedConnectorService;
  tlsCaCertificatePem: string;
  tlsPolicy: "allow_self_signed" | "strict";
  username: string;
}

function defaultCredentialKind(service: ManagedConnectorService): FormFields["authKind"] {
  if (service === "jellyfin") return "none";
  if (service === "qbittorrent") return "username_password";
  return "api_key";
}

function initialFields(connector?: ConnectorAdmin): FormFields {
  const service = connector?.service ?? "jellyfin";
  return {
    apiKey: "",
    authKind: connector?.credentialKind ?? defaultCredentialKind(service),
    baseUrl: connector?.baseUrl ?? "",
    displayName: connector?.displayName ?? connectorServicePresentation[service].label,
    id: connector?.id ?? `${service}-primary`,
    insecureHttpApproved: connector?.insecureHttpApproved ?? false,
    password: "",
    service,
    tlsCaCertificatePem: "",
    tlsPolicy: connector?.tlsPolicy ?? "strict",
    username: "",
  };
}

function credentialInput(fields: FormFields): ConnectorCredentialInput {
  if (fields.authKind === "api_key") return { apiKey: fields.apiKey, kind: "api_key" };
  if (fields.authKind === "username_password") {
    return { kind: "username_password", password: fields.password, username: fields.username };
  }
  return { kind: "none" };
}

function replacementCredentials(
  fields: FormFields,
  connector: ConnectorAdmin,
): ConnectorCredentialInput | undefined {
  if (fields.authKind === "api_key") {
    return fields.apiKey.length > 0 ? { apiKey: fields.apiKey, kind: "api_key" } : undefined;
  }
  if (fields.authKind === "username_password") {
    return fields.username.length > 0 || fields.password.length > 0
      ? { kind: "username_password", password: fields.password, username: fields.username }
      : undefined;
  }
  return connector.credentialKind === "none" ? undefined : { kind: "none" };
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

export function ConnectorForm({
  busy,
  connector,
  mode,
  onCancel,
  onSubmit,
  recoveryOnly,
}: ConnectorFormProperties) {
  const formId = useId();
  const [fields, setFields] = useState(() => initialFields(connector));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const availableServices = recoveryOnly ? (["jellyfin"] as const) : connectorServices;
  const allowsOptionalApiKey = fields.service === "seerr" || fields.service === "sabnzbd";

  const update = <Key extends keyof FormFields>(key: Key, value: FormFields[Key]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };

  const selectService = (service: ManagedConnectorService) => {
    setFields((current) => ({
      ...current,
      authKind: defaultCredentialKind(service),
      displayName:
        current.displayName === connectorServicePresentation[current.service].label
          ? connectorServicePresentation[service].label
          : current.displayName,
      id: current.id === `${current.service}-primary` ? `${service}-primary` : current.id,
      service,
    }));
    setErrors({});
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    const isHttp = fields.baseUrl.startsWith("http://");
    if (isHttp && !fields.insecureHttpApproved) {
      nextErrors.insecureHttpApproved = "Explicitly approve plain HTTP for this private service.";
    }
    if (
      fields.tlsPolicy === "allow_self_signed" &&
      fields.tlsCaCertificatePem.length === 0 &&
      !(mode === "edit" && connector?.tlsCaCertificateConfigured)
    ) {
      nextErrors.tlsCaCertificatePem = "Paste the CA certificate used to verify this service.";
    }
    if (mode === "edit" && fields.authKind === "username_password") {
      const hasUsername = fields.username.length > 0;
      const hasPassword = fields.password.length > 0;
      if (hasUsername !== hasPassword) {
        nextErrors.password = "Enter both username and password to replace saved credentials.";
      }
    }
    if (
      mode === "edit" &&
      fields.authKind === "api_key" &&
      connector?.credentialKind !== "api_key" &&
      fields.apiKey.length === 0
    ) {
      nextErrors.credentials = "Enter an API key to change the authentication method.";
    }

    const common = {
      baseUrl: fields.baseUrl.trim(),
      displayName: fields.displayName.trim(),
      insecureHttpApproved: fields.insecureHttpApproved,
      tlsPolicy: fields.tlsPolicy,
      ...(fields.tlsCaCertificatePem.trim().length > 0
        ? { tlsCaCertificatePem: fields.tlsCaCertificatePem.trim() }
        : {}),
    };
    const input =
      mode === "create"
        ? {
            ...common,
            credentials: credentialInput(fields),
            id: fields.id.trim(),
            service: fields.service,
          }
        : {
            ...common,
            ...(replacementCredentials(fields, connector!)
              ? { credentials: replacementCredentials(fields, connector!) }
              : {}),
            revision: connector!.revision,
          };
    const parsed =
      mode === "create"
        ? connectorCreateRequestSchema.safeParse(input)
        : connectorUpdateRequestSchema.safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "form");
        nextErrors[key] ??= issue.message;
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !parsed.success) return;
    await onSubmit(parsed.data);
  };

  return (
    <form className={styles.connectorForm} noValidate onSubmit={submit}>
      <div className={styles.formHeading}>
        <div>
          <p className="section-kicker">{mode === "create" ? "New signal" : "Configuration"}</p>
          <h2>{mode === "create" ? "Connect a service." : `Tune ${connector!.displayName}.`}</h2>
          <p>
            Secrets travel directly to the gateway and are never returned to this browser. New and
            materially changed connectors remain disabled until they pass a fresh probe.
          </p>
        </div>
        <LockKeyhole aria-hidden="true" size={24} />
      </div>

      {mode === "create" ? (
        <fieldset className={styles.servicePicker}>
          <legend>Service type</legend>
          <div>
            {availableServices.map((service) => {
              const presentation = connectorServicePresentation[service];
              const Icon = presentation.icon;
              return (
                <button
                  aria-pressed={fields.service === service}
                  data-service={service}
                  key={service}
                  onClick={() => selectService(service)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={19} />
                  <span>{presentation.label}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className={styles.formGrid}>
        <Field error={errors.displayName} label="Display name" name={`${formId}-display-name`}>
          <input
            autoComplete="off"
            id={`${formId}-display-name`}
            onChange={(event) => update("displayName", event.target.value)}
            value={fields.displayName}
          />
        </Field>
        {mode === "create" ? (
          <Field
            description="Stable internal identifier; it cannot be changed later."
            error={errors.id}
            label="Connector ID"
            name={`${formId}-id`}
          >
            <input
              autoCapitalize="none"
              autoComplete="off"
              id={`${formId}-id`}
              onChange={(event) => update("id", event.target.value)}
              spellCheck={false}
              value={fields.id}
            />
          </Field>
        ) : null}
        <Field
          description="Origin or base path only. URLs with credentials, query strings, or fragments are rejected."
          error={errors.baseUrl}
          label="Service URL"
          name={`${formId}-base-url`}
        >
          <input
            autoCapitalize="none"
            autoComplete="url"
            id={`${formId}-base-url`}
            inputMode="url"
            onChange={(event) => {
              const baseUrl = event.target.value;
              setFields((current) => ({
                ...current,
                baseUrl,
                insecureHttpApproved: baseUrl.startsWith("http://")
                  ? current.insecureHttpApproved
                  : false,
              }));
              setErrors((current) => ({ ...current, baseUrl: "" }));
            }}
            spellCheck={false}
            value={fields.baseUrl}
          />
        </Field>
        <Field error={errors.tlsPolicy} label="Transport trust" name={`${formId}-tls-policy`}>
          <select
            id={`${formId}-tls-policy`}
            onChange={(event) => update("tlsPolicy", event.target.value as FormFields["tlsPolicy"])}
            value={fields.tlsPolicy}
          >
            <option value="strict">Verified public or private CA</option>
            <option value="allow_self_signed">Pinned self-signed CA</option>
          </select>
        </Field>
      </div>

      {fields.tlsPolicy === "allow_self_signed" ? (
        <Field
          description={
            mode === "edit" && connector?.tlsCaCertificateConfigured
              ? "Leave blank to keep the currently pinned certificate."
              : "A single PEM-encoded CA certificate is required."
          }
          error={errors.tlsCaCertificatePem}
          label="Trusted CA certificate"
          name={`${formId}-ca-certificate`}
        >
          <textarea
            autoCapitalize="none"
            autoComplete="off"
            id={`${formId}-ca-certificate`}
            onChange={(event) => update("tlsCaCertificatePem", event.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
            spellCheck={false}
            value={fields.tlsCaCertificatePem}
          />
        </Field>
      ) : null}

      {fields.baseUrl.startsWith("http://") ? (
        <label className={styles.riskApproval}>
          <input
            checked={fields.insecureHttpApproved}
            onChange={(event) => update("insecureHttpApproved", event.target.checked)}
            type="checkbox"
          />
          <span>
            <strong>I approve unencrypted HTTP for this destination.</strong>
            <small>Credentials and media metadata may be visible on the network path.</small>
          </span>
          {errors.insecureHttpApproved ? (
            <small className={styles.fieldError} role="alert">
              {errors.insecureHttpApproved}
            </small>
          ) : null}
        </label>
      ) : null}

      {fields.service !== "jellyfin" ? (
        <section className={styles.credentials} aria-labelledby={`${formId}-credentials-title`}>
          <div>
            <Fingerprint aria-hidden="true" size={19} />
            <div>
              <h3 id={`${formId}-credentials-title`}>Service authentication</h3>
              <p>
                {mode === "edit"
                  ? "Saved credentials stay sealed. Leave replacement fields empty to preserve them."
                  : "Use a dedicated service account with the narrowest practical upstream role."}
              </p>
            </div>
          </div>
          {allowsOptionalApiKey ? (
            <label className={styles.inlineSelect}>
              <span>Authentication method</span>
              <select
                onChange={(event) =>
                  update("authKind", event.target.value as FormFields["authKind"])
                }
                value={fields.authKind}
              >
                <option value="api_key">API key</option>
                <option value="none">No authentication</option>
              </select>
            </label>
          ) : null}
          {fields.authKind === "api_key" ? (
            <Field
              description={mode === "edit" ? "Leave blank to keep the saved API key." : undefined}
              error={errors.credentials}
              label="API key"
              name={`${formId}-api-key`}
            >
              <input
                autoComplete="new-password"
                id={`${formId}-api-key`}
                onChange={(event) => update("apiKey", event.target.value)}
                type="password"
                value={fields.apiKey}
              />
            </Field>
          ) : fields.authKind === "username_password" ? (
            <div className={styles.formGrid}>
              <Field error={errors.username} label="Username" name={`${formId}-username`}>
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  id={`${formId}-username`}
                  onChange={(event) => update("username", event.target.value)}
                  value={fields.username}
                />
              </Field>
              <Field
                description={
                  mode === "edit" ? "Enter both fields to replace the saved login." : undefined
                }
                error={errors.password ?? errors.credentials}
                label="Password"
                name={`${formId}-password`}
              >
                <input
                  autoComplete="new-password"
                  id={`${formId}-password`}
                  onChange={(event) => update("password", event.target.value)}
                  type="password"
                  value={fields.password}
                />
              </Field>
            </div>
          ) : null}
        </section>
      ) : null}

      {errors.form ? (
        <p className={styles.formError} role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className={styles.formActions}>
        {onCancel ? (
          <button className={styles.secondaryButton} onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
        <button className={styles.primaryButton} disabled={busy} type="submit">
          {busy ? (
            <LoaderCircle aria-hidden="true" className={styles.spinner} size={16} />
          ) : mode === "create" ? (
            <Plus aria-hidden="true" size={16} />
          ) : (
            <Save aria-hidden="true" size={16} />
          )}
          {mode === "create" ? "Save disabled connector" : "Save and re-probe"}
        </button>
      </div>
    </form>
  );
}
