"use client";

import type {
  ConnectorAdmin,
  JellyfinProvisioningConfig,
  JellyfinProvisioningCredentialWrite,
  JellyfinProvisioningTemplateSummary,
} from "@omnifin/contracts/connectors";
import { Check, CircleAlert, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  ConnectorAdminClientError,
  jellyfinProvisioningClient,
  type JellyfinProvisioningClient,
} from "../lib/connector-admin";
import styles from "./connector-control-room.module.css";

function safeError(error: unknown) {
  if (!(error instanceof ConnectorAdminClientError)) return "The operation could not be completed. Re-enter any credential and try again.";
  if (error.code.includes("connector_disabled")) return "Bring the Jellyfin connector online, then try again.";
  if (error.code.includes("not_verified")) return "Probe the Jellyfin connector successfully before loading templates.";
  if (error.code.includes("credential_invalid")) return "Use a valid elevated Jellyfin administrator credential, then save it again.";
  if (error.code.includes("credential_not_configured")) return "Save a provisioning credential before loading templates.";
  if (error.code.includes("revision_conflict")) return "These settings changed elsewhere. The latest version is loaded; re-enter any credential and try again.";
  return error.message || "The operation could not be completed. Re-enter any credential and try again. No unconfirmed settings were applied.";
}

function timestamp(value: string | null) {
  if (!value) return "Not validated yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Validation time unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export interface JellyfinProvisioningSettingsProperties {
  connector: ConnectorAdmin;
  csrfToken: string;
  client?: JellyfinProvisioningClient;
}

export function JellyfinProvisioningSettings({ connector, csrfToken, client = jellyfinProvisioningClient }: JellyfinProvisioningSettingsProperties) {
  const [config, setConfig] = useState<JellyfinProvisioningConfig | null>(null);
  const [templates, setTemplates] = useState<readonly JellyfinProvisioningTemplateSummary[]>([]);
  const [templateUserId, setTemplateUserId] = useState("");
  const [credentialMode, setCredentialMode] = useState<"password" | "api_key">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<"load" | "templates" | "save" | "clear" | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refetchConfig = useCallback(async () => {
    setBusy("load");
    setError(null);
    try {
      const next = await client.get(connector.id);
      setConfig(next);
      setEnabled(next.enabled);
      setTemplateUserId(next.template?.id ?? "");
    } catch (reason) {
      setError(safeError(reason));
    } finally {
      setBusy(null);
    }
  }, [client, connector.id]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setConfig(null);
      setTemplates([]);
      setTemplateUserId("");
      setUsername("");
      setPassword("");
      setApiKey("");
      setEnabled(false);
      setConfirmClear(false);
      setBusy("load");
      setError(null);
      return client.get(connector.id);
    }).then((next) => {
      if (!next || controller.signal.aborted) return;
      setConfig(next);
      setEnabled(next.enabled);
      setTemplateUserId(next.template?.id ?? "");
      setBusy(null);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) { setError(safeError(reason)); setBusy(null); }
    });
    return () => controller.abort();
  }, [client, connector.id]);

  if (connector.service !== "jellyfin") return null;
  const credentialExists = config?.credentialConfigured === true;
  const canLoadTemplates = credentialExists && connector.enabled && connector.healthState === "healthy";
  const selectedTemplate = templates.find((template) => template.id === templateUserId) ?? config?.template ?? null;
  const canEnable = Boolean(selectedTemplate) && credentialExists;

  const save = async (credential: JellyfinProvisioningCredentialWrite, nextEnabled = enabled, nextTemplateUserId = selectedTemplate?.id ?? null) => {
    if (!config) return;
    setBusy("save"); setError(null); setNotice(null);
    try {
      const next = await client.update(connector.id, { credential, enabled: nextEnabled && canEnable, revision: config.revision, templateUserId: nextTemplateUserId }, csrfToken);
      setConfig(next); setEnabled(next.enabled); setTemplateUserId(next.template?.id ?? "");
      setNotice(next.enabled ? "Provisioning template enabled." : "Credential saved. Provisioning remains disabled until you choose a template.");
    } catch (reason) {
      const message = safeError(reason);
      setError(message);
      if (reason instanceof ConnectorAdminClientError && reason.code.includes("revision_conflict")) {
        await refetchConfig();
        setError(message);
      }
    } finally {
      setUsername(""); setPassword(""); setApiKey("");
      setBusy(null);
    }
  };

  const loadTemplates = async () => {
    setBusy("templates"); setError(null);
    try { const result = await client.templates(connector.id); setTemplates(result.templates); setNotice(`${result.templates.length} template${result.templates.length === 1 ? "" : "s"} available.`); }
    catch (reason) { setError(safeError(reason)); }
    finally { setBusy(null); }
  };

  return <section className={styles.provisioning} aria-labelledby="provisioning-title">
    <div className={styles.sectionHeading}><div><p className="section-kicker">Jellyfin identity</p><h3 id="provisioning-title">Provisioning template</h3></div><ShieldCheck aria-hidden="true" size={19} /></div>
    <p className={styles.provisioningIntro}>An opt-in template for future account provisioning. This setting does not create or adopt Jellyfin accounts yet.</p>
    {busy === "load" ? <p role="status" aria-busy="true" className={styles.quietCopy}>Loading provisioning status…</p> : null}
    {error ? <div className={styles.formError} role="alert"><CircleAlert aria-hidden="true" size={16} /> {error}<button className={styles.inlineAction} onClick={() => void refetchConfig()} type="button">Retry</button></div> : null}
    {config ? <>
      <div className={styles.provisioningGrid}>
        <fieldset className={styles.provisioningFieldset} disabled={busy !== null}>
          <legend>Administrator credential</legend>
          <p className={styles.fieldHint}>Credentials are sealed by the gateway. Existing secrets are never shown or returned.</p>
          <div className={styles.choiceRow}>
            <label><input checked={credentialMode === "password"} name="provisioning-credential" onChange={() => setCredentialMode("password")} type="radio" /> Username and password</label>
            <label><input checked={credentialMode === "api_key"} name="provisioning-credential" onChange={() => setCredentialMode("api_key")} type="radio" /> Server API key</label>
          </div>
          {credentialMode === "password" ? <div className={styles.provisioningInputs}><label className={styles.field}>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} /></label><label className={styles.field}>Password<input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label></div> : <label className={styles.field}>Server API key<input autoComplete="new-password" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>}
          <button className={styles.primaryButton} disabled={busy !== null || (credentialMode === "password" ? !username || !password : !apiKey)} onClick={() => void save(credentialMode === "password" ? { kind: "replace_password", username, password } : { kind: "replace_api_key", apiKey }, false)} type="button"><KeyRound aria-hidden="true" size={15} /> Save credential (disabled)</button>
          <div className={styles.credentialStatus} data-configured={credentialExists} role="status"><Check aria-hidden="true" size={14} /><span>{credentialExists ? `${config.credentialKind === "api_key" ? "Server API key" : "Username and password"} configured · ${config.validationState === "valid" ? "Validated" : "Needs validation"}` : "No provisioning credential configured"}<small>{timestamp(config.validatedAt)}</small></span></div>
        </fieldset>
        <div className={styles.templatePanel}>
          <div><strong>Template user</strong><p className={styles.fieldHint}>Choose by display name. Jellyfin policy details are not changed here.</p></div>
          <button className={styles.secondaryButton} disabled={!canLoadTemplates || busy !== null} onClick={() => void loadTemplates()} type="button">{busy === "templates" ? <LoaderCircle className={styles.spinner} aria-hidden="true" size={15} /> : <RefreshCw aria-hidden="true" size={15} />} {busy === "templates" ? "Loading templates…" : templates.length ? "Refresh templates" : "Load templates"}</button>
          {busy === "templates" ? <p className={styles.quietCopy} role="status" aria-live="polite" aria-busy="true">Loading template users…</p> : null}
           {!credentialExists ? <p className={styles.quietCopy}>Save a credential first. It will be staged disabled.</p> : !connector.enabled ? <p className={styles.quietCopy}>Bring the connector online to safely inspect its templates.</p> : connector.healthState !== "healthy" ? <p className={styles.quietCopy}>Probe the connector successfully before loading templates.</p> : <label className={styles.field}>Template user<select aria-label="Template user" value={templateUserId} onChange={(event) => setTemplateUserId(event.target.value)}><option value="">Select a template user</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.displayName}</option>)}</select></label>}
          {credentialExists ? <label className={styles.enableChoice}><input checked={enabled} disabled={!canEnable || busy !== null} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" /><span><strong>{enabled ? "Provisioning is enabled" : "Keep provisioning disabled"}</strong><small>{canEnable ? "When enabled, future provisioning will use this template." : "Select a valid template before enabling."}</small></span></label> : null}
          {credentialExists ? <button className={styles.liveButton} disabled={busy !== null || !canEnable} onClick={() => void save({ kind: "retain" }, enabled)} type="button">Save template settings</button> : null}
        </div>
      </div>
      {credentialExists ? <div className={styles.provisioningDanger}>{confirmClear ? <div role="group" aria-label="Confirm clearing provisioning credential"><span>Clear the sealed credential and disable provisioning?</span><button className={styles.secondaryButton} onClick={() => setConfirmClear(false)} type="button">Keep credential</button><button className={styles.dangerButton} disabled={busy !== null} onClick={() => { setConfirmClear(false); void save({ kind: "clear" }, false, null); }} type="button"><Trash2 size={15} /> Clear credential</button></div> : <button className={styles.dangerButton} disabled={busy !== null} onClick={() => setConfirmClear(true)} type="button"><Trash2 size={15} /> Clear credential</button>}</div> : null}
      {notice ? <p className={styles.provisioningNotice} role="status">{notice}</p> : null}
    </> : null}
  </section>;
}
