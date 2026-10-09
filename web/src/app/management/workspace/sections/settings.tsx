"use client";

import { useState } from "react";
import { AlertTriangle, Building2, CreditCard, Mail, RefreshCw, Send, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { api, errorMessage, type EmailLogEntry, type SettingView, type SettingsChanges, type SettingsSnapshot } from "@/lib/api";
import { dateTimeLabel } from "../format";
import { Empty, Field, InlineError, Tip, useAction, useResource, type SectionProps } from "../ui";

const EMAIL_SWITCHES = ["email.guest_notifications", "email.staff_notifications", "email.management_alerts"];

function SettingInput({ setting, value, onChange, clear, onClear }: { setting: SettingView; value: string; onChange: (value: string) => void; clear: boolean; onClear: (clear: boolean) => void }) {
  if (setting.secret) {
    return (
      <Field
        label={setting.label}
        tip={`${setting.description} This is a secret from the provider's dashboard: it's encrypted on the server and never shown again once saved.`}
        hint={!setting.readable ? "The saved value cannot be decrypted with the server's key. Enter it again." : setting.configured ? `Saved ${setting.hint ?? ""}. Leave blank to keep it.` : `Not set. ${setting.description}`}
      >
        <input type="password" autoComplete="off" spellCheck={false} value={value} disabled={clear} onChange={(event) => onChange(event.target.value)} placeholder={setting.configured ? "Enter a new value to replace it" : "Paste the key"} />
        {setting.configured && (
          <label className="checkbox-line">
            <input type="checkbox" checked={clear} onChange={(event) => onClear(event.target.checked)} /> Remove the saved value
          </label>
        )}
      </Field>
    );
  }
  if (setting.type === "integer") {
    return (
      <Field
        label={setting.label}
        tip={`${setting.description}${setting.minimum !== null && setting.maximum !== null ? ` Allowed: ${setting.minimum} to ${setting.maximum}.` : ""} Default ${String(setting.default)}.`}
        hint={`${setting.description} Default ${String(setting.default)}.`}
      >
        <input type="number" min={setting.minimum ?? undefined} max={setting.maximum ?? undefined} step="1" required value={value} onChange={(event) => onChange(event.target.value)} />
      </Field>
    );
  }
  if (setting.type === "string") {
    return (
      <Field label={setting.label} tip={setting.description} hint={setting.description}>
        <input type="text" autoComplete="off" spellCheck={false} value={value} onChange={(event) => onChange(event.target.value)} placeholder={setting.key === "email.from_address" ? "Houzz Hills <bookings@yourdomain.com>" : "frontdesk@yourdomain.com"} />
      </Field>
    );
  }
  return null;
}

function ProviderChoice({ legend, tip, name, setting, value, onChange }: { legend: string; tip?: string; name: string; setting: SettingView | undefined; value: string; onChange: (value: string) => void }) {
  return (
    <fieldset className="provider-choice">
      <legend>
        {legend}
        {tip && <Tip text={tip} />}
      </legend>
      {(setting?.options ?? []).map((option) => (
        <label key={option.value} className={value === option.value ? "selected" : ""}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}

const STATUS_TONE: Record<EmailLogEntry["status"], string> = { sent: "status-green", queued: "status-blue", sending: "status-blue", skipped: "status-gold", failed: "status-red" };

function EmailLogPanel({ version }: { version: number }) {
  const [reloads, setReloads] = useState(0);
  const log = useResource(() => api.settings.emailLog(), `${version}:${reloads}`);
  const counts = log.data?.counts ?? {};
  return (
    <section className="panel bookings-panel full-panel email-log">
      <div className="panel-heading bookings-heading">
        <div>
          <h2>
            <Mail size={16} /> Email delivery log
            <Tip text="Every email the system sent or tried to send in the last 7 days, so you can check a guest or staff member actually received their message." />
          </h2>
          <p>
            Last 7 days: {counts.sent ?? 0} sent · {counts.failed ?? 0} failed · {counts.skipped ?? 0} skipped
            {(counts.queued ?? 0) + (counts.sending ?? 0) > 0 ? ` · ${(counts.queued ?? 0) + (counts.sending ?? 0)} waiting` : ""}
          </p>
        </div>
        <button type="button" className="button-secondary" onClick={() => setReloads((current) => current + 1)}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <InlineError message={log.error} />
      {log.data && log.data.messages.length === 0 ? (
        <Empty text="No emails yet. Confirmations, receipts and alerts appear here once email is on." />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th data-tip="The email's subject, and who it was for: a guest, a staff account or a management alert.">SUBJECT</th>
                <th data-tip="The recipient's email address.">TO</th>
                <th data-tip="When the email was created and put in the sending queue.">QUEUED</th>
                <th data-tip="Sent: accepted by the email service. Queued / sending: waiting or in progress. Skipped: not sent because that type of email is switched off or not configured. Failed: couldn't be delivered.">STATUS</th>
                <th data-tip="Why an email failed or was skipped, or how many attempts it took.">NOTE</th>
              </tr>
            </thead>
            <tbody>
              {(log.data?.messages ?? []).map((message) => (
                <tr key={message.id}>
                  <td>
                    <strong className="payment-person">{message.subject ?? message.template}</strong>
                    <small className="payment-unit">{message.audience === "management" ? "Management alert" : message.audience === "staff" ? "Staff account" : "Guest"}</small>
                  </td>
                  <td>{message.recipient}</td>
                  <td>{dateTimeLabel(message.createdAt)}</td>
                  <td>
                    <span className={`status ${STATUS_TONE[message.status]}`}>
                      <i />
                      {message.status}
                    </span>
                  </td>
                  <td className="email-log-note">{message.lastError ?? (message.attempts > 1 ? `Sent after ${message.attempts} attempts` : "—")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SettingsForm({ snapshot, notify, onSaved }: { snapshot: SettingsSnapshot; notify: SectionProps["notify"]; onSaved: () => void }) {
  const byKey = new Map(snapshot.settings.map((setting) => [setting.key, setting]));
  const providerSetting = byKey.get("payments.provider");
  const emailProviderSetting = byKey.get("email.provider");
  const providerLabel = (value: string) => providerSetting?.options?.find((option) => option.value === value)?.label ?? value;
  const initialProvider = String(providerSetting?.value ?? "none");
  const initialEmailProvider = String(emailProviderSetting?.value ?? "none");
  const [provider, setProvider] = useState(initialProvider);
  const [emailProvider, setEmailProvider] = useState(initialEmailProvider);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      snapshot.settings
        .filter((setting) => setting.type === "integer" || (setting.type === "string" && !setting.secret))
        .map((setting) => [setting.key, String(setting.value ?? setting.default ?? "")]),
    ),
  );
  const [switches, setSwitches] = useState<Record<string, string>>(() => Object.fromEntries(EMAIL_SWITCHES.map((key) => [key, String(byKey.get(key)?.value ?? "on")])));
  const [cleared, setCleared] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verifyResult, setVerifyResult] = useState("");
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  const secrets = snapshot.settings.filter((setting) => setting.secret);
  const integers = snapshot.settings.filter((setting) => setting.type === "integer");
  const texts = snapshot.settings.filter((setting) => setting.type === "string" && !setting.secret);
  const unreadable = secrets.filter((setting) => !setting.readable);
  const resendKey = byKey.get("email.resend_api_key");
  const emailReady = Boolean(resendKey?.configured && resendKey.readable && byKey.get("email.from_address")?.value);

  const input = (setting: SettingView) => (
    <SettingInput
      key={setting.key}
      setting={setting}
      value={values[setting.key] ?? ""}
      onChange={(value) => setValues((current) => ({ ...current, [setting.key]: value }))}
      clear={Boolean(cleared[setting.key])}
      onClear={(clear) => setCleared((current) => ({ ...current, [setting.key]: clear }))}
    />
  );

  const save = async () => {
    const changes: SettingsChanges = {};
    if (provider !== initialProvider) changes["payments.provider"] = provider;
    if (emailProvider !== initialEmailProvider) changes["email.provider"] = emailProvider;
    for (const setting of secrets) {
      if (cleared[setting.key]) changes[setting.key] = null;
      else if (values[setting.key]?.trim()) changes[setting.key] = values[setting.key]!.trim();
    }
    for (const setting of integers) {
      const next = Number(values[setting.key]);
      if (next !== setting.value) changes[setting.key] = next;
    }
    for (const setting of texts) {
      const next = values[setting.key]?.trim() ?? "";
      if (next !== (setting.value ?? "")) changes[setting.key] = next === "" ? null : next;
    }
    for (const key of EMAIL_SWITCHES) {
      if (switches[key] !== byKey.get(key)?.value) changes[key] = switches[key] ?? "on";
    }
    if (Object.keys(changes).length === 0) {
      notify("Nothing to save");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.settings.update(changes);
      notify("Settings saved");
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught, "Unable to save settings"));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setVerifyResult("");
    try {
      const result = await api.settings.verifyPayments();
      setVerifyResult(`${providerLabel(result.provider)} accepted the saved key.`);
    } catch (caught) {
      setVerifyResult(errorMessage(caught, "Verification failed"));
    }
  };

  const sendTest = async () => {
    setTestResult("");
    setTesting(true);
    try {
      const result = await api.settings.sendTestEmail();
      setTestResult(`Sent to ${result.to}. Check your inbox.`);
    } catch (caught) {
      setTestResult(errorMessage(caught, "The test email could not be sent"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <InlineError message={error} onDismiss={() => setError("")} />
      {unreadable.length > 0 && (
        <div className="inline-error" role="alert">
          <span>
            <AlertTriangle size={13} /> {unreadable.map((setting) => setting.label).join(", ")} cannot be decrypted. Re-enter {unreadable.length === 1 ? "it" : "them"} below; the related feature stays off until then.
          </span>
        </div>
      )}
      <section className="settings-grid">
        <article className="panel settings-card">
          <div className="panel-heading">
            <div>
              <h2>
                <CreditCard size={16} /> Online payments
                <Tip text="Lets guests pay for website bookings by card or transfer through Paystack or Flutterwave. Choose a provider, paste its secret key, then add the webhook URL in the provider's dashboard so payments confirm bookings automatically." />
              </h2>
              <p>Hosted checkout for website bookings. Keys are encrypted on the server and never shown again.</p>
            </div>
          </div>
          <ProviderChoice
            legend="Provider"
            tip="Which payment company processes website payments. Off: guests can still book, but can't pay online."
            name="provider" setting={providerSetting} value={provider} onChange={setProvider} />
          {secrets
            // Credentials for the selected provider, plus any saved ones so they can be cleared.
            .filter((setting) => setting.group === "payments" && (setting.provider === provider || (setting.configured && setting.provider !== null)))
            .map(input)}
          <div className="webhook-url">
            <span>
              Webhook URL for the provider dashboard
              <Tip text="Copy this address into your Paystack or Flutterwave dashboard (Settings → Webhooks). The provider calls it when a payment succeeds, which confirms the booking automatically." />
            </span>
            {snapshot.environment.webhookUrl ? (
              <div className="secret-reveal">
                <code>{snapshot.environment.webhookUrl}</code>
                <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(snapshot.environment.webhookUrl ?? "")}>
                  Copy
                </button>
              </div>
            ) : (
              <small>PUBLIC_WEB_URL is not configured on the server, so online payments cannot be enabled yet.</small>
            )}
          </div>
          {initialProvider !== "none" && (
            <div className="verify-row">
              <button type="button" className="button-secondary" onClick={() => void verify()}>
                <ShieldCheck size={15} /> Check saved key with {providerLabel(initialProvider)}
              </button>
              {verifyResult && <span>{verifyResult}</span>}
            </div>
          )}
        </article>

        <article className="panel settings-card">
          <div className="panel-heading">
            <div>
              <h2>
                <Mail size={16} /> Email notifications
                <Tip text="Sends booking confirmations, receipts, staff sign-in emails and management alerts through Resend. Add the API key and sender, send yourself a test, then choose which emails to send." />
              </h2>
              <p>Booking confirmations, receipts, staff account emails and management alerts, sent through Resend. The key is encrypted on the server and never shown again.</p>
            </div>
          </div>
          <ProviderChoice
            legend="Delivery"
            tip="How emails are delivered. Off: no emails are sent; they're logged as skipped."
            name="email-provider" setting={emailProviderSetting} value={emailProvider} onChange={setEmailProvider} />
          {resendKey && input(resendKey)}
          {texts.filter((setting) => setting.group === "email").map(input)}
          <fieldset className="email-switches">
            <legend>
              What to send
              <Tip text="Turn each group of emails on or off: messages to guests, messages to staff about their accounts, and alerts to owners and managers." />
            </legend>
            {EMAIL_SWITCHES.map((key) => {
              const setting = byKey.get(key);
              if (!setting) return null;
              return (
                <label key={key} className="email-switch">
                  <input type="checkbox" checked={switches[key] === "on"} onChange={(event) => setSwitches((current) => ({ ...current, [key]: event.target.checked ? "on" : "off" }))} />
                  <span>
                    <strong>{setting.label}</strong>
                    <small>{setting.description}</small>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <div className="verify-row">
            <button type="button" className="button-secondary" disabled={!emailReady || testing} onClick={() => void sendTest()} title={emailReady ? undefined : "Save the Resend API key and sender first"}>
              <Send size={14} /> {testing ? "Sending…" : "Send a test email to me"}
            </button>
            {testResult ? <span>{testResult}</span> : !emailReady && <span>Save the key and sender, then send a test before turning email on.</span>}
          </div>
        </article>

        <article className="panel settings-card">
          <div className="panel-heading">
            <div>
              <h2>
                <SlidersHorizontal size={16} /> Booking and payment rules
                <Tip text="Limits that every booking follows, from staff and the website, such as how far ahead guests can book and how long an unpaid booking holds its room." />
              </h2>
              <p>Apply to staff and website bookings immediately.</p>
            </div>
          </div>
          {integers.map(input)}
        </article>
      </section>
      <div className="settings-footer">
        <small>
          Last changed{" "}
          {(() => {
            const latest = [...snapshot.settings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            return latest ? `${dateTimeLabel(latest.updatedAt)}${latest.updatedBy ? ` by ${latest.updatedBy}` : ""}` : "never";
          })()}
        </small>
        <button className="button-primary" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}

/** The property name is the brand everywhere: workspace logo, receipts, booking pages and emails. */
function PropertyNamePanel({ name, notify }: { name: string; notify: SectionProps["notify"] }) {
  const [value, setValue] = useState(name);
  const action = useAction();
  const save = () =>
    action.run(async () => {
      const saved = await api.settings.renameProperty(value.trim());
      notify(`Property renamed to ${saved.name}`);
      // Reload so the logo and every page pick up the new name.
      window.setTimeout(() => window.location.reload(), 900);
    }, "Unable to rename the property");
  return (
    <section className="panel settings-card property-name-card">
      <div className="panel-heading">
        <div>
          <h2>
            <Building2 size={16} /> Property name
            <Tip text="Your business name as guests and staff see it." />
          </h2>
          <p>Shown in the workspace logo, on receipts and booking pages, and as the brand at the top and bottom of every email.</p>
        </div>
      </div>
      <InlineError message={action.error} onDismiss={action.clearError} />
      <div className="property-name-row">
        <Field label="Name" tip="The property's name, shown in the workspace logo, on receipts and booking pages, and in every email. Saving reloads the page.">
          <input value={value} maxLength={120} onChange={(event) => setValue(event.target.value)} placeholder="Houzzhills" />
        </Field>
        <button className="button-primary" disabled={action.busy || !value.trim() || value.trim() === name} onClick={() => void save()}>
          {action.busy ? "Saving…" : "Save name"}
        </button>
      </div>
    </section>
  );
}

export function SettingsSection({ notify, property }: SectionProps) {
  const [version, setVersion] = useState(0);
  const snapshot = useResource(() => api.settings.get(), String(version));
  if (!snapshot.data) return <InlineError message={snapshot.error} />;
  return (
    <>
      <PropertyNamePanel name={property.name} notify={notify} />
      <SettingsForm key={version} snapshot={snapshot.data} notify={notify} onSaved={() => setVersion((current) => current + 1)} />
      <EmailLogPanel version={version} />
    </>
  );
}
