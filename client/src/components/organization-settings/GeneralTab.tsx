'use client';

import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { useOrganization, type OrgColor } from '@/components/providers';
import { Button, Spinner } from '@/components/ui';
import { apiFetch, errorMessage } from '@/lib/api-client';
import { ORG_COLOR_CLASS, ORG_COLOR_OPTIONS } from '@/lib/org-colors';

interface GeneralTabProps {
    orgId: string;
    currentRole: string;
}

export function GeneralTab({ orgId, currentRole }: GeneralTabProps) {
    const { organization, updateOrganization } = useOrganization();
    const [isEditing, setIsEditing] = useState(false);
    const [name, setName] = useState(organization?.name || '');
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isSavingColor, setIsSavingColor] = useState(false);

    const canEdit = currentRole === 'owner' || currentRole === 'admin';

    const handleSave = async () => {
        if (!name.trim()) {
            setError('Name is required');
            return;
        }

        setIsSaving(true);
        setError(null);

        try {
            const data = await apiFetch<{ organization: { name: string } }>(`/api/organizations/${orgId}`, {
                method: 'PATCH',
                json: { name: name.trim() },
            });
            updateOrganization({ id: orgId, name: data.organization.name });
            setIsEditing(false);
        } catch (err) {
            setError(errorMessage(err, 'Failed to update organization'));
        } finally {
            setIsSaving(false);
        }
    };

    const handleColorChange = async (color: OrgColor) => {
        if (isSavingColor) return;

        setIsSavingColor(true);
        setError(null);

        try {
            await apiFetch(`/api/organizations/${orgId}`, { method: 'PATCH', json: { color } });
            updateOrganization({ id: orgId, color });
        } catch (err) {
            setError(errorMessage(err, 'Failed to update color'));
        } finally {
            setIsSavingColor(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* Organization Name */}
            <div className="rounded-md bg-surface-raised border border-edge p-6">
                <h3 className="text-lg font-medium text-ink mb-4">Organization Name</h3>

                {isEditing ? (
                    <div className="space-y-3">
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="block w-full max-w-md rounded-md bg-surface-raised border border-edge-strong px-3 py-2 text-ink placeholder-ink-faint focus:border-accent focus:ring-1 focus:ring-accent outline-none"
                            placeholder="Organization name"
                        />
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <div className="flex gap-2">
                            <Button variant="primary" onClick={handleSave} loading={isSaving}>
                                {!isSaving && <Check className="size-4" />}
                                Save
                            </Button>
                            <Button
                                onClick={() => {
                                    setIsEditing(false);
                                    setName(organization?.name || '');
                                    setError(null);
                                }}
                            >
                                <X className="size-4" />
                                Cancel
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex items-center gap-4">
                        <span className="text-ink">{organization?.name}</span>
                        {canEdit && (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm text-ink-muted hover:text-ink-secondary hover:bg-surface-hover rounded-md transition-colors cursor-pointer"
                            >
                                <Pencil className="size-4" />
                                Edit
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Organization Color */}
            <div className="rounded-md bg-surface-raised border border-edge p-6">
                <h3 className="text-lg font-medium text-ink mb-2">Organization Color</h3>
                <p className="text-sm text-ink-muted mb-4">Choose a color for your organization avatar.</p>

                <div className="flex flex-wrap gap-3">
                    {ORG_COLOR_OPTIONS.map((colorOption) => {
                        const isSelected = organization?.color === colorOption.value;
                        const isDefault = !organization?.color && colorOption.value === 'emerald';

                        return (
                            <button
                                key={colorOption.value}
                                onClick={() => handleColorChange(colorOption.value)}
                                disabled={!canEdit || isSavingColor}
                                className={`group relative size-10 rounded-md ${ORG_COLOR_CLASS[colorOption.value]} transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${
                                    isSelected || isDefault
                                        ? 'ring-2 ring-offset-2 ring-ink ring-offset-surface-raised'
                                        : 'hover:scale-110 hover:shadow-floating'
                                }`}
                                title={colorOption.label}
                            >
                                {(isSelected || isDefault) && (
                                    <Check className="size-5 text-on-emphasis absolute inset-0 m-auto" />
                                )}
                            </button>
                        );
                    })}
                </div>
                {isSavingColor && (
                    <p className="mt-3 text-sm text-ink-muted flex items-center gap-2">
                        <Spinner size="sm" />
                        Saving...
                    </p>
                )}
            </div>
        </div>
    );
}
