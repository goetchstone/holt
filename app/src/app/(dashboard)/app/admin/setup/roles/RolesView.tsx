"use client";

// /app/src/app/(dashboard)/app/admin/setup/roles/RolesView.tsx
//
// Admin > Setup > Roles. The GUI door of the permission layer
// (docs/domains/staff-auth.md): list the roles a deployment has, clone one to
// make another, and edit what each can do — in the catalog's own operator
// language, never in permission keys.
//
// Four choices here are the whole point of the screen, and are not incidental
// styling:
//
//   1. CREATE IS ALWAYS A CLONE. There is no "blank role" path. An empty grid
//      of forty-odd checkboxes is the thing that makes a permission UI go
//      unused: nobody knows which fifteen boxes reproduce "a designer", so they
//      give up and assign Manager to everyone. Starting from a role that
//      already works turns the job into "take three things away".
//   2. SENSITIVE GRANTS LOOK DIFFERENT AND ASK FIRST. The catalog marks the
//      permissions that move money or hand power to someone else. Those rows
//      are visually distinct and switching one ON goes through a confirmation
//      naming what it lets a person do. Switching one OFF does not — taking
//      power away is never the dangerous direction.
//   3. THE BASELINE IS STATED, NOT DRAWN AS A DISABLED CHECKBOX. Every role
//      holds the floor implicitly and no write path can change that, so a
//      greyed checkbox would be a control that looks broken. It is a sentence
//      and a list of facts instead.
//   4. 409s ARE PINNED, NOT TOASTED. The API answers a refused delete or edit
//      with a plain-language explanation of what would break ("that would leave
//      nobody who can manage staff"). That is not a four-second message.
//
// Talks to /api/admin/roles over REST; every route there is gated on
// staff.manage. Chrome comes from the (dashboard) layout — no container here.

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { AlertTriangle, ArrowLeft, Loader2, Plus, ShieldAlert } from "lucide-react";

import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import FormTextArea from "@/components/form/FormTextArea";
import FormDropdown from "@/components/form/FormDropdown";
import FormCheckbox from "@/components/form/FormCheckbox";
import { getErrorMessage } from "@/lib/toastError";
import { cn } from "@/lib/utils";

import {
  baselineEntries,
  clonedGrants,
  deleteBlockedReason,
  deriveRoleKey,
  grantDiff,
  groupGrantsByDomain,
  isRefusal,
  reassignSentence,
  reassignTargets,
  sanitizeGrants,
  sensitiveGrants,
  staffCountPhrase,
  type BaselineEntry,
  type CatalogPayload,
  type CatalogPermission,
  type GrantDomainGroup,
  type RoleDetail,
  type RolesIndexPayload,
  type RoleSummary,
} from "./rolesModel";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

/** A refusal the server explained. Stays on screen until the operator fixes it. */
function RefusalNotice({ message }: Readonly<{ message: string }>) {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

function RoleBadges({ role }: Readonly<{ role: RoleSummary }>) {
  return (
    <>
      {role.isSystem ? <Badge variant="info">Shipped with holt</Badge> : null}
      {role.grantsAllPermissions ? <Badge variant="danger">Every permission</Badge> : null}
      {role.grantsCustomized ? <Badge variant="warning">Customized</Badge> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The grant grid
// ---------------------------------------------------------------------------

/**
 * One capability. Rendered as "Refund payment — Return money to a customer."
 * because the operator is deciding about the sentence, not about the key —
 * `payment.refund` appears nowhere on this screen.
 */
function GrantRow({
  permission,
  held,
  readOnly,
  onToggle,
}: Readonly<{
  permission: CatalogPermission;
  held: boolean;
  readOnly: boolean;
  onToggle: (permission: CatalogPermission, next: boolean) => void;
}>) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-md border px-3 pt-4",
        permission.sensitive ? "border-sh-gold/60 bg-sh-gold/10" : "border-black/10 bg-white",
        held ? "" : "opacity-90",
      )}
    >
      <FormCheckbox
        name={`grant-${permission.key}`}
        label={`${permission.label} — ${permission.description}`}
        checked={held}
        disabled={readOnly}
        onChange={(e) => onToggle(permission, e.target.checked)}
      />
      {permission.sensitive ? (
        <Badge variant="warning" className="mt-0.5 shrink-0 gap-1">
          <AlertTriangle className="h-3 w-3" />
          Sensitive
        </Badge>
      ) : null}
    </div>
  );
}

function DomainCard({
  group,
  held,
  readOnly,
  onToggle,
}: Readonly<{
  group: GrantDomainGroup;
  held: ReadonlySet<string>;
  readOnly: boolean;
  onToggle: (permission: CatalogPermission, next: boolean) => void;
}>) {
  const granted = group.permissions.filter((p) => held.has(p.key)).length;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle>{group.label}</CardTitle>
          <span className="text-xs text-sh-gray">
            {granted} of {group.permissions.length} granted
          </span>
        </div>
        {group.description ? <CardDescription>{group.description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {group.permissions.map((permission) => (
          <GrantRow
            key={permission.key}
            permission={permission}
            held={held.has(permission.key)}
            readOnly={readOnly}
            onToggle={onToggle}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/** The floor: on for everyone, ungrantable, unrevokable. Stated, not drawn. */
function BaselineCard({ entries }: Readonly<{ entries: BaselineEntry[] }>) {
  if (entries.length === 0) return null;
  return (
    <Card className="mb-6 bg-sh-stripe">
      <CardHeader>
        <CardTitle className="text-sh-gray">Every role can always do their own job</CardTitle>
        <CardDescription>
          These are on for every role in holt, including this one. They are not granted and cannot
          be taken away.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {entries.map((entry) => (
          <div
            key={entry.key}
            className="flex items-start justify-between gap-3 rounded-md border border-black/5 bg-white/60 px-3 py-2 text-sm text-sh-gray"
          >
            <span>
              <span className="font-medium">{entry.label}</span>
              {entry.description ? ` — ${entry.description}` : null}
            </span>
            <Badge variant="neutral" className="shrink-0">
              Always on
            </Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

/** What changes when this is saved, said in permission labels rather than counts. */
function PendingChanges({
  added,
  removed,
  catalog,
}: Readonly<{ added: string[]; removed: string[]; catalog: CatalogPayload }>) {
  if (added.length === 0 && removed.length === 0) return null;
  const addedSensitive = sensitiveGrants(added, catalog);
  return (
    <div className="mb-4 rounded-md border border-black/10 bg-sh-linen/40 p-4 text-sm">
      <p className="text-sh-black">
        Unsaved: {added.length} permission{added.length === 1 ? "" : "s"} added, {removed.length}{" "}
        removed.
      </p>
      {addedSensitive.length > 0 ? (
        <p className="mt-2 text-sh-black">
          <AlertTriangle className="mr-1 inline h-4 w-4 text-sh-gold" />
          Sensitive additions: {addedSensitive.map((p) => p.label).join(", ")}. Anyone holding this
          role will be able to do these.
        </p>
      ) : null}
    </div>
  );
}

function EveryPermissionNotice() {
  return (
    <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      This role holds every permission there is, including ones added by future releases of holt.
      That is a property of the role itself and cannot be edited here. To make a narrower version,
      go back and create a new role starting from this one, then take permissions away.
    </div>
  );
}

function ShippedRoleNotice() {
  return (
    <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      This role ships with holt. Changing what it can do means holt stops keeping its permissions up
      to date: future releases will still correct its name and description, but a permission a later
      release adds will no longer reach this role on its own.
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  baseline,
  onBack,
  onSaved,
}: Readonly<{
  role: RoleDetail;
  catalog: CatalogPayload;
  baseline: string[];
  onBack: () => void;
  onSaved: (role: RoleDetail) => void;
}>) {
  const original = useMemo(
    () => sanitizeGrants(role.permissions, baseline),
    [role.permissions, baseline],
  );
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? "");
  const [rank, setRank] = useState(String(role.rank));
  const [grants, setGrants] = useState<string[]>(original);
  const [pending, setPending] = useState<CatalogPermission | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const groups = useMemo(() => groupGrantsByDomain(catalog, baseline), [catalog, baseline]);
  const floor = useMemo(() => baselineEntries(catalog, baseline), [catalog, baseline]);
  const diff = useMemo(() => grantDiff(original, grants), [original, grants]);

  // A wildcard role's grants are a flag, not rows: showing its grid as editable
  // would be a lie, since PUT refuses to change grantsAllPermissions.
  const readOnly = role.grantsAllPermissions;
  const held = useMemo(
    () => new Set(readOnly ? catalog.permissions.map((p) => p.key) : grants),
    [readOnly, catalog.permissions, grants],
  );

  const grantsChanged = diff.added.length > 0 || diff.removed.length > 0;
  const dirty =
    grantsChanged ||
    name !== role.name ||
    description !== (role.description ?? "") ||
    rank !== String(role.rank);

  const setHeld = (key: string, next: boolean) => {
    setGrants((prev) =>
      next ? sanitizeGrants([...prev, key], baseline) : prev.filter((k) => k !== key),
    );
  };

  const toggle = (permission: CatalogPermission, next: boolean) => {
    // Granting power asks first; taking it away never does.
    if (next && permission.sensitive) {
      setPending(permission);
      return;
    }
    setHeld(permission.key, next);
  };

  const confirmPending = () => {
    if (pending) setHeld(pending.key, true);
    setPending(null);
  };

  const save = async () => {
    if (!name.trim()) {
      toast.error("A role needs a name.");
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      const { data } = await axios.put<{ role: RoleDetail }>(`/api/admin/roles/${role.id}`, {
        name: name.trim(),
        description: description.trim(),
        rank: Math.max(0, Number.parseInt(rank, 10) || 0),
        // Omitted for a wildcard role — it holds everything by flag, and asking
        // to set a list would be asking for a change PUT is required to refuse.
        permissions: readOnly ? undefined : grants,
      });
      toast.success(`${data.role.name} saved`);
      onSaved(data.role);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "Could not save this role");
      if (isRefusal(err)) setRefusal(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={role.name}
        subtitle={`${staffCountPhrase(role.staffCount)} hold this role.`}
        actions={
          <>
            <Button variant="secondary" onClick={onBack} disabled={saving}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              All roles
            </Button>
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <RoleBadges role={role} />
      </div>

      {refusal ? <RefusalNotice message={refusal} /> : null}

      <Card className="mb-6">
        <CardContent className="pt-6">
          <FormInput label="Name" name="role-name" value={name} onChange={setName} />
          <div className="mb-4">
            <FormTextArea
              label="Description"
              name="role-description"
              value={description}
              onChange={setDescription}
              rows={2}
              placeholder="What this job does, in a sentence."
            />
          </div>
          <FormInput
            label="Impersonation rank"
            name="role-rank"
            type="number"
            value={rank}
            onChange={setRank}
          />
          <p className="-mt-2 text-xs text-sh-gray">
            Used for one thing only: nobody can impersonate a role ranked above their own. Leave it
            at 0 unless this role genuinely outranks another — 0 means a different job, not a lower
            rung.
          </p>
        </CardContent>
      </Card>

      <BaselineCard entries={floor} />

      {readOnly ? <EveryPermissionNotice /> : null}
      {!readOnly && role.isSystem && grantsChanged ? <ShippedRoleNotice /> : null}
      {!readOnly ? (
        <PendingChanges added={diff.added} removed={diff.removed} catalog={catalog} />
      ) : null}

      <div className="space-y-4">
        {groups.map((group) => (
          <DomainCard
            key={group.key}
            group={group}
            held={held}
            readOnly={readOnly}
            onToggle={toggle}
          />
        ))}
      </div>

      {pending ? (
        <Modal
          title="Grant a sensitive permission?"
          onClose={() => setPending(null)}
          onSave={confirmPending}
          saveLabel="Grant it"
        >
          <p className="text-sm text-sh-black">
            <span className="font-semibold">{pending.label}</span> — {pending.description}
          </p>
          <p className="text-sm text-sh-gray">
            This one moves money or hands power to someone else. Everyone holding{" "}
            <span className="text-sh-black">{role.name}</span> will be able to do it, including
            people assigned to the role later.
          </p>
          <p className="text-xs text-sh-gray">
            Nothing is saved until you choose Save changes on the role.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create (always a clone)
// ---------------------------------------------------------------------------

function CreateRoleModal({
  roles,
  catalog,
  baseline,
  onClose,
  onCreated,
}: Readonly<{
  roles: RoleSummary[];
  catalog: CatalogPayload;
  baseline: string[];
  onClose: () => void;
  onCreated: (role: RoleDetail) => void;
}>) {
  const [sourceId, setSourceId] = useState("");
  const [source, setSource] = useState<RoleDetail | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const key = deriveRoleKey(name);
  const grants = source ? clonedGrants(source, catalog, baseline) : [];
  const sensitive = sensitiveGrants(grants, catalog);

  const pickSource = async (value: string) => {
    setSourceId(value);
    setSource(null);
    if (!value) return;
    setLoadingSource(true);
    try {
      const { data } = await axios.get<{ role: RoleDetail }>(`/api/admin/roles/${value}`);
      setSource(data.role);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not read that role's permissions"));
    } finally {
      setLoadingSource(false);
    }
  };

  const create = async () => {
    if (!source) {
      toast.error("Choose the role to start from.");
      return;
    }
    if (!name.trim() || !key) {
      toast.error("Give the role a name with at least one letter or number.");
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      const { data } = await axios.post<{ role: RoleDetail }>("/api/admin/roles", {
        key,
        name: name.trim(),
        description: description.trim(),
        copyFromRoleId: source.id,
        permissions: grants,
      });
      toast.success(`${data.role.name} created from ${source.name}`);
      onCreated(data.role);
    } catch (err: unknown) {
      const message = getErrorMessage(err, "Could not create this role");
      if (isRefusal(err)) setRefusal(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New role"
      onClose={onClose}
      onSave={create}
      saving={saving}
      saveLabel="Create role"
    >
      <p className="text-sm text-sh-gray">
        Start from a role that already works, then take away what this one should not do. Nothing
        about the role you copy changes.
      </p>

      <FormDropdown
        label="Role to copy"
        options={roles.map((role) => ({ id: String(role.id), name: role.name }))}
        value={sourceId}
        onChange={pickSource}
        disabled={saving}
      />

      {loadingSource ? (
        <p className="flex items-center gap-2 text-sm text-sh-gray">
          <Loader2 className="h-4 w-4 animate-spin" /> Reading that role…
        </p>
      ) : null}

      {source ? (
        <div className="rounded-md border border-black/10 bg-sh-linen/40 p-3 text-sm">
          <p className="text-sh-black">
            Copies {grants.length} permission{grants.length === 1 ? "" : "s"} from {source.name}.
          </p>
          {source.grantsAllPermissions ? (
            <p className="mt-1 text-xs text-sh-gray">
              {source.name} holds everything, so the new role starts with every permission in the
              catalog. Take away what it should not have.
            </p>
          ) : null}
          {sensitive.length > 0 ? (
            <p className="mt-1 text-xs text-sh-gray">
              <AlertTriangle className="mr-1 inline h-3 w-3 text-sh-gold" />
              {sensitive.length} of them are sensitive — they move money or hand power to someone
              else. You can remove them on the next screen.
            </p>
          ) : null}
        </div>
      ) : null}

      <FormInput
        label="Name"
        name="new-role-name"
        value={name}
        onChange={setName}
        placeholder="e.g. Floor Lead"
      />
      {key ? (
        <p className="-mt-2 text-xs text-sh-gray">
          Permanent identifier: <span className="text-sh-black">{key}</span>. Built from the name
          and never changes, so the name can be edited later without breaking anything.
        </p>
      ) : null}

      <FormTextArea
        label="Description"
        name="new-role-description"
        value={description}
        onChange={setDescription}
        rows={2}
        placeholder="What this job does, in a sentence."
      />

      {refusal ? <RefusalNotice message={refusal} /> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Delete (asks where the staff go)
// ---------------------------------------------------------------------------

function DeleteRoleModal({
  role,
  roles,
  onClose,
  onDeleted,
}: Readonly<{
  role: RoleSummary;
  roles: RoleSummary[];
  onClose: () => void;
  onDeleted: () => void;
}>) {
  const [targetId, setTargetId] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const targets = reassignTargets(roles, role.id);
  const target = targets.find((r) => String(r.id) === targetId) ?? null;
  const blocked = deleteBlockedReason(role, target?.id ?? null);

  const remove = async () => {
    if (blocked) {
      toast.error(blocked);
      return;
    }
    setSaving(true);
    setRefusal(null);
    try {
      const query = target ? `?reassignToRoleId=${target.id}` : "";
      const { data } = await axios.delete<{ ok: true; reassigned: number }>(
        `/api/admin/roles/${role.id}${query}`,
      );
      toast.success(
        data.reassigned > 0
          ? `${role.name} deleted — ${staffCountPhrase(data.reassigned)} moved to ${target?.name}`
          : `${role.name} deleted`,
      );
      onDeleted();
    } catch (err: unknown) {
      const message = getErrorMessage(err, "Could not delete this role");
      if (isRefusal(err)) setRefusal(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Delete ${role.name}?`}
      onClose={onClose}
      onSave={remove}
      saving={saving}
      saveLabel="Delete role"
    >
      <p className="text-sm text-sh-black">
        {reassignSentence(role.staffCount, target?.name ?? null)}
      </p>

      {role.staffCount > 0 ? (
        <FormDropdown
          label="Move them to"
          options={targets.map((r) => ({ id: String(r.id), name: r.name }))}
          value={targetId}
          onChange={setTargetId}
          disabled={saving}
        />
      ) : null}

      <p className="text-xs text-sh-gray">
        Deleting a role does not delete anybody. Their permissions become whatever the role they
        move to allows.
      </p>

      {blocked ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {blocked}
        </p>
      ) : null}

      {refusal ? <RefusalNotice message={refusal} /> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function RoleList({
  roles,
  opening,
  onOpen,
  onDelete,
}: Readonly<{
  roles: RoleSummary[];
  opening: number | null;
  onOpen: (role: RoleSummary) => void;
  onDelete: (role: RoleSummary) => void;
}>) {
  // A deployment always has the built-ins, so this is a "the seeder never ran"
  // state rather than a first-run one — say that instead of showing an empty
  // table and letting the operator guess.
  if (roles.length === 0) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        No roles exist in this database at all, not even the ones that ship with holt. That means
        the built-in role seeder has not run here. Deploying again runs it, or an operator can run{" "}
        <code>npm run seed:roles</code>.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-sh-stripe text-sh-gray">
          <tr>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 text-right font-medium">Staff</th>
            <th className="px-3 py-2 text-right font-medium">Permissions</th>
            <th className="px-3 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {roles.map((role) => (
            <tr key={role.id} className="border-t border-black/5 align-top">
              <td className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sh-black">{role.name}</span>
                  <RoleBadges role={role} />
                </div>
                <p className="mt-1 text-xs text-sh-gray">
                  {role.description || "No description yet."}
                </p>
              </td>
              <td className="px-3 py-3 text-right text-sh-black">{role.staffCount}</td>
              <td className="px-3 py-3 text-right text-sh-black">
                {role.grantsAllPermissions ? "All" : role.permissionCount}
              </td>
              <td className="px-3 py-3">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onOpen(role)}
                    disabled={opening === role.id}
                  >
                    {opening === role.id ? "Opening…" : "Edit"}
                  </Button>
                  {role.isSystem ? null : (
                    <Button size="sm" variant="secondary" onClick={() => onDelete(role)}>
                      Delete
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function RolesView() {
  const [index, setIndex] = useState<RolesIndexPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RoleDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<RoleSummary | null>(null);
  const [opening, setOpening] = useState<number | null>(null);

  // Deliberately does NOT flip `loading` back on: every write path calls this
  // to refresh counts while the operator is still looking at the editor they
  // just saved, and a full-page spinner on each save is a flicker, not
  // feedback. The initial state is already true, and the retry button below
  // owns the flag for the one case that needs it.
  const load = useCallback(async () => {
    try {
      const { data } = await axios.get<RolesIndexPayload>("/api/admin/roles");
      setIndex(data);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not load roles"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRole = async (role: RoleSummary) => {
    setOpening(role.id);
    try {
      const { data } = await axios.get<{ role: RoleDetail }>(`/api/admin/roles/${role.id}`);
      setEditing(data.role);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, `Could not open ${role.name}`));
    } finally {
      setOpening(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sh-gray">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading roles…
      </div>
    );
  }

  if (!index) {
    return (
      <div>
        <PageHeader title="Roles" subtitle="What each job can do in holt." />
        <p className="mb-4 text-sh-gray">Roles could not be loaded.</p>
        <Button
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (editing) {
    return (
      <RoleEditor
        key={editing.id}
        role={editing}
        catalog={index.catalog}
        baseline={index.baseline}
        onBack={() => setEditing(null)}
        onSaved={(role) => {
          setEditing(role);
          void load();
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Roles"
        subtitle="What each job can do in holt. Every staff member holds one role, and the role holds the permissions."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New role
          </Button>
        }
      />

      <RoleList roles={index.roles} opening={opening} onOpen={openRole} onDelete={setDeleting} />

      <p className="mt-3 text-xs text-sh-gray">
        Roles that ship with holt cannot be deleted — an installation that could delete
        Administrator could lock itself out. What they can do is still yours to change.
      </p>

      {creating ? (
        <CreateRoleModal
          roles={index.roles}
          catalog={index.catalog}
          baseline={index.baseline}
          onClose={() => setCreating(false)}
          onCreated={(role) => {
            setCreating(false);
            setEditing(role);
            void load();
          }}
        />
      ) : null}

      {deleting ? (
        <DeleteRoleModal
          role={deleting}
          roles={index.roles}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}
