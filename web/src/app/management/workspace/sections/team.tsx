"use client";

import { useState } from "react";
import { Clock3, KeyRound, Pencil, Plus } from "lucide-react";
import { api, errorMessage, type EmploymentStatus, type Role, type Staff } from "@/lib/api";
import { dateLabel, dateTimeLabel, humanize, initials, optionLabel, text, timeLabel } from "../format";
import { DetailList, Drawer, Empty, Field, InlineError, Modal, useAction, useConfirm, useResource, type SectionProps } from "../ui";

/** Shows a one-time temporary password; it cannot be retrieved again. */
function PasswordReveal({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  return (
    <Modal title="Temporary password" description={`Give this to ${name} privately. It is shown only once and must be changed at first sign-in.`} onClose={onClose}>
      <div className="secret-reveal">
        <code>{password}</code>
        <button type="button" className="button-secondary" onClick={() => void navigator.clipboard.writeText(password)}>
          Copy
        </button>
      </div>
    </Modal>
  );
}

export function TeamSection({ notify, refreshKey, can, reference, clockedIn, onClock, focus }: SectionProps & { clockedIn: boolean | null; onClock: () => void }) {
  const staff = useResource(() => api.staff.list(), String(refreshKey));
  const [onboarding, setOnboarding] = useState(focus?.intent === "create");
  const [revealed, setRevealed] = useState<{ name: string; password: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(focus?.id ?? null);
  const [editing, setEditing] = useState<Staff | null>(null);
  const action = useAction();
  const { confirm, dialog } = useConfirm();
  const list = staff.data ?? [];
  const open = list.find((member) => member.id === openId) ?? null;

  const setStatus = async (member: Staff, status: EmploymentStatus) => {
    const label = optionLabel(reference.employmentStatuses, status).toLowerCase();
    const accepted = await confirm(
      status === "active"
        ? { title: `Reactivate ${member.full_name}?`, message: "They can sign in again.", confirmLabel: "Reactivate" }
        : { title: `Mark ${member.full_name} as ${label}?`, message: "Their sign-in is disabled and they are signed out everywhere. Their records are kept.", confirmLabel: `Mark ${label}`, danger: true },
    );
    if (accepted === null) return;
    try {
      await api.staff.updateStatus(member.id, status);
      notify(`${member.full_name} updated`);
      await staff.reload();
    } catch (error) {
      notify(errorMessage(error, "Staff update failed"));
    }
  };

  const resetPassword = async (member: Staff) => {
    const accepted = await confirm({ title: `Reset ${member.full_name}'s password?`, message: "A new temporary password is issued and shown once. Their current sessions end.", confirmLabel: "Reset password", danger: true });
    if (accepted === null) return;
    try {
      const { temporaryPassword } = await api.staff.resetPassword(member.id);
      setRevealed({ name: member.full_name, password: temporaryPassword });
    } catch (error) {
      notify(errorMessage(error, "Password reset failed"));
    }
  };

  return (
    <>
      <section className="panel bookings-panel full-panel">
        <div className="panel-heading bookings-heading">
          <div>
            <h2>Team & attendance</h2>
            <p>Staff accounts, roles and latest clock event.</p>
          </div>
          <div className="heading-actions">
            <span className="booking-count">{list.length} team members</span>
            {reference.assignableRoles.length > 0 && (
              <button className="button-primary" onClick={() => setOnboarding(true)}>
                <Plus size={16} /> Onboard staff
              </button>
            )}
          </div>
        </div>
        <InlineError message={staff.error} />
        {list.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>STAFF MEMBER</th>
                  <th>EMPLOYEE ID</th>
                  <th>DEPARTMENT</th>
                  <th>ROLE</th>
                  <th>LAST EVENT</th>
                  <th>EMPLOYMENT</th>
                  {can("staff:write") && <th>MANAGE</th>}
                </tr>
              </thead>
              <tbody>
                {list.map((member) => (
                  <tr key={member.id} className={`row-link ${member.employment_status === "terminated" ? "row-muted" : ""}`} onClick={() => setOpenId(member.id)}>
                    <td>
                      <div className="guest-cell">
                        <span className="guest-avatar tone-blue">{initials(member.full_name)}</span>
                        <div>
                          <strong>{member.full_name}</strong>
                          <small>
                            {member.email} · {member.job_title}
                            {member.phone ? ` · ${member.phone}` : ""}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td>{member.employee_number}</td>
                    <td>{member.department}</td>
                    <td>{optionLabel(reference.roles, member.role)}</td>
                    <td>
                      {member.last_attendance_event ? humanize(member.last_attendance_event) : "No clock event"}
                      {member.last_attendance_at ? ` · ${timeLabel(member.last_attendance_at)}` : ""}
                    </td>
                    <td>
                      <span className={`status ${member.employment_status === "active" ? "status-green" : "status-gold"}`}>
                        <i />
                        {optionLabel(reference.employmentStatuses, member.employment_status)}
                      </span>
                    </td>
                    {can("staff:write") && (
                      <td onClick={(event) => event.stopPropagation()}>
                        {member.can_manage ? (
                          <div className="reservation-actions">
                            <select className="inline-select" value={member.employment_status} onChange={(event) => void setStatus(member, event.target.value as EmploymentStatus)} aria-label={`Employment status for ${member.full_name}`}>
                              {reference.employmentStatuses.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                            <button className="icon-text-button" onClick={() => void resetPassword(member)} aria-label={`Reset password for ${member.full_name}`}>
                              <KeyRound size={14} />
                            </button>
                          </div>
                        ) : (
                          <span className="quiet-action">—</span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !staff.loading && <Empty text="No staff have been onboarded yet." />
        )}
      </section>

      {clockedIn !== null && (
        <section className="panel operations-panel attendance-self">
          <div className="panel-heading">
            <div>
              <h2>Your attendance</h2>
              <p>{clockedIn ? "You are clocked in." : "You are clocked out."}</p>
            </div>
          </div>
          <button className="button-primary" onClick={onClock}>
            <Clock3 size={15} />
            {clockedIn ? "Clock out" : "Clock in"}
          </button>
        </section>
      )}

      {onboarding && (
        <Modal
          title="Onboard staff member"
          description="Leave the temporary password empty to generate a strong one. The account must change it at first sign-in."
          busy={action.busy}
          error={action.error}
          onClose={() => setOnboarding(false)}
          onSubmit={(values) =>
            action.run(async () => {
              const password = text(values.get("temporaryPassword"));
              const created = await api.staff.create({
                fullName: text(values.get("fullName")),
                email: text(values.get("email")),
                employeeNumber: text(values.get("employeeNumber")),
                department: text(values.get("department")),
                jobTitle: text(values.get("jobTitle")),
                role: text(values.get("role")) as Role,
                phone: text(values.get("phone")),
                emergencyContact: text(values.get("emergencyContact")),
                startDate: text(values.get("startDate")),
                ...(password ? { temporaryPassword: password } : {}),
              });
              setOnboarding(false);
              notify("Staff account created");
              if (created.temporaryPassword) setRevealed({ name: text(values.get("fullName")), password: created.temporaryPassword });
              await staff.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Full name">
              <input name="fullName" required maxLength={120} />
            </Field>
            <Field label="Work email">
              <input name="email" type="email" required maxLength={254} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Employee number">
              <input name="employeeNumber" required maxLength={40} />
            </Field>
            <Field label="Department">
              <input name="department" required maxLength={80} placeholder="Front desk" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Job title">
              <input name="jobTitle" required maxLength={80} />
            </Field>
            <Field label="Role">
              <select name="role" required>
                {reference.assignableRoles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="Phone">
              <input name="phone" type="tel" maxLength={32} />
            </Field>
            <Field label="Emergency contact">
              <input name="emergencyContact" maxLength={160} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Start date">
              <input name="startDate" type="date" />
            </Field>
            <Field label="Temporary password (optional, 12+ characters)">
              <input name="temporaryPassword" type="password" minLength={12} maxLength={256} autoComplete="new-password" />
            </Field>
          </div>
        </Modal>
      )}
      {open && (
        <Drawer
          title={open.full_name}
          subtitle={`${open.job_title} · ${optionLabel(reference.roles, open.role)}`}
          badge={
            <span className={`status ${open.employment_status === "active" ? "status-green" : "status-gold"}`}>
              <i />
              {optionLabel(reference.employmentStatuses, open.employment_status)}
            </span>
          }
          onClose={() => setOpenId(null)}
          actions={
            open.can_manage && (
              <>
                {open.employment_status === "active" ? (
                  <button className="button-ghost-danger" onClick={() => void setStatus(open, "terminated")} data-tip="Disables sign-in. Records are kept and you can reactivate later.">
                    End employment
                  </button>
                ) : (
                  <button className="button-secondary" onClick={() => void setStatus(open, "active")}>
                    Reactivate
                  </button>
                )}
                {open.employment_status === "active" && (
                  <button className="button-secondary" onClick={() => void setStatus(open, "on_leave")}>
                    On leave
                  </button>
                )}
                <span className="spacer" />
                <button className="button-secondary" onClick={() => void resetPassword(open)} data-tip="Issues a one-time password and signs them out everywhere">
                  <KeyRound size={15} /> Reset password
                </button>
                <button className="button-primary" onClick={() => setEditing(open)}>
                  <Pencil size={15} /> Edit
                </button>
              </>
            )
          }
        >
          <DetailList
            title="Employment"
            rows={[
              ["Employee number", open.employee_number],
              ["Department", open.department],
              ["Job title", open.job_title],
              ["Workspace role", optionLabel(reference.roles, open.role)],
              ["Start date", open.start_date ? dateLabel(open.start_date) : null],
            ]}
          />
          <DetailList
            title="Contact"
            rows={[
              ["Work email", open.email],
              ["Phone", open.phone],
              ["Emergency contact", open.emergency_contact],
            ]}
          />
          <DetailList
            title="Attendance"
            rows={[["Last clock event", open.last_attendance_event ? `${humanize(open.last_attendance_event)} · ${open.last_attendance_at ? dateTimeLabel(open.last_attendance_at) : ""}` : "No clock event yet"]]}
          />
        </Drawer>
      )}

      {editing && (
        <Modal
          title={`Edit ${editing.full_name}`}
          description="Changing the role signs them out everywhere so the new access applies at once. The sign-in email can't be changed here."
          busy={action.busy}
          error={action.error}
          wide
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            action.run(async () => {
              const optional = (name: string) => text(values.get(name)) || null;
              const role = text(values.get("role")) as Role;
              const result = await api.staff.updateProfile(editing.id, {
                fullName: text(values.get("fullName")),
                employeeNumber: text(values.get("employeeNumber")),
                department: text(values.get("department")),
                jobTitle: text(values.get("jobTitle")),
                ...(role && role !== editing.role ? { role } : {}),
                phone: optional("phone"),
                emergencyContact: optional("emergencyContact"),
                startDate: optional("startDate"),
              });
              setEditing(null);
              notify(result.sessionsRevoked > 0 ? `${text(values.get("fullName"))} updated and signed out to apply the new role` : `${text(values.get("fullName"))} updated`);
              await staff.reload();
            })
          }
        >
          <div className="form-row">
            <Field label="Full name">
              <input name="fullName" required maxLength={120} defaultValue={editing.full_name} />
            </Field>
            <Field label="Employee number">
              <input name="employeeNumber" required maxLength={40} defaultValue={editing.employee_number} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Department">
              <input name="department" required maxLength={80} defaultValue={editing.department} />
            </Field>
            <Field label="Job title">
              <input name="jobTitle" required maxLength={80} defaultValue={editing.job_title} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Workspace role">
              <select name="role" defaultValue={editing.role}>
                {!reference.assignableRoles.some((role) => role.value === editing.role) && <option value={editing.role}>{optionLabel(reference.roles, editing.role)}</option>}
                {reference.assignableRoles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start date">
              <input name="startDate" type="date" defaultValue={editing.start_date ?? ""} />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Phone">
              <input name="phone" type="tel" maxLength={32} pattern="[\+0-9 \(\)\-]*" defaultValue={editing.phone ?? ""} />
            </Field>
            <Field label="Emergency contact">
              <input name="emergencyContact" maxLength={160} defaultValue={editing.emergency_contact ?? ""} />
            </Field>
          </div>
        </Modal>
      )}
      {dialog}
      {revealed && <PasswordReveal name={revealed.name} password={revealed.password} onClose={() => setRevealed(null)} />}
    </>
  );
}
