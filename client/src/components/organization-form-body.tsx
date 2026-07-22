import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import type { Organization, InsertOrganization, UpdateOrganization } from '@shared/schema';
import { OrganizationImageField } from './organization-form-image-field';

export function OrganizationFormBody({ editOrg, onClose }: { editOrg?: Organization | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const darkFileInputRef = useRef<HTMLInputElement>(null);
  const appIconInputRef = useRef<HTMLInputElement>(null);
  const editId = editOrg?.id ?? null;

  const [name, setName] = useState(editOrg?.name ?? '');
  const [slug, setSlug] = useState(editOrg?.slug ?? '');
  const [subdomain, setSubdomain] = useState(editOrg?.subdomain ?? '');
  const [address, setAddress] = useState(editOrg?.address ?? '');
  const [city, setCity] = useState(editOrg?.city ?? '');
  const [state, setState] = useState(editOrg?.state ?? '');
  const [zipCode, setZipCode] = useState(editOrg?.zipCode ?? '');
  const [phone, setPhone] = useState(editOrg?.phone ?? '');
  const [email, setEmail] = useState(editOrg?.email ?? '');
  const [logo, setLogo] = useState<string | null>(editOrg?.logo ?? null);
  const [logoPreview, setLogoPreview] = useState<string | null>(editOrg?.logo ?? null);
  const [darkLogo, setDarkLogo] = useState<string | null>(editOrg?.darkLogo ?? null);
  const [darkLogoPreview, setDarkLogoPreview] = useState<string | null>(editOrg?.darkLogo ?? null);
  const [appIcon, setAppIcon] = useState<string | null>(editOrg?.appIcon ?? null);
  const [appIconPreview, setAppIconPreview] = useState<string | null>(editOrg?.appIcon ?? null);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPhone, setAdminPhone] = useState('');

  const createMutation = useMutation({
    mutationFn: async (org: InsertOrganization) => {
      return apiRequest('/api/organizations', 'POST', org);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/organizations'] });
      toast({ title: 'Organization Created', description: 'The organization has been successfully created.' });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to create organization: ${error.message}`, variant: 'destructive' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, org }: { id: number; org: UpdateOrganization }) => {
      return apiRequest(`/api/organizations/${id}`, 'PATCH', org);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/organizations'] });
      toast({ title: 'Organization Updated', description: 'The organization has been successfully updated.' });
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to update organization: ${error.message}`, variant: 'destructive' });
    },
  });

  const generateSlug = () => {
    if (!name) return;
    const newSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    setSlug(newSlug);
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!editId) {
      if (!adminName || !adminEmail) {
        toast({ title: 'Missing Administrator Information', description: 'Please fill out all required administrator fields.', variant: 'destructive' });
        return;
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(adminEmail)) {
        toast({ title: 'Invalid Email', description: 'Please enter a valid email address for the administrator.', variant: 'destructive' });
        return;
      }
    }

    const orgData = {
      name,
      slug,
      subdomain: subdomain || null,
      address,
      city,
      state,
      zipCode,
      phone,
      email,
      logo: logo || undefined,
      darkLogo: darkLogo ?? undefined,
      appIcon: appIcon ?? undefined,
    };

    if (editId) {
      updateMutation.mutate({ id: editId, org: orgData });
    } else {
      const adminData = { name: adminName, email: adminEmail, phone: adminPhone || null };
      const dataToSend = { ...orgData, active: true, adminData };
      createMutation.mutate(dataToSend);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editId ? 'Edit Organization' : 'Create Organization'}</DialogTitle>
        <DialogDescription>
          {editId
            ? 'Update the organization details below.'
            : 'Add a new organization to the system with an administrator account.'}
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleFormSubmit}>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="name" className="md:text-right">Name</Label>
            <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} onBlur={generateSlug} className="md:col-span-3" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="slug" className="md:text-right">Slug</Label>
            <Input id="slug" required value={slug} onChange={(e) => setSlug(e.target.value)} className="md:col-span-3" placeholder="org-name" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="subdomain" className="md:text-right">Subdomain</Label>
            <div className="md:col-span-3">
              <div className="flex items-center gap-1">
                <Input id="subdomain" value={subdomain} onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))} className="flex-1" placeholder="orgname" />
                <span className="text-sm text-muted-foreground whitespace-nowrap">.leaguevault.app</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Custom subdomain for this org (lowercase letters and numbers only). Leave blank to use the slug.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="phone" className="md:text-right">Phone</Label>
            <Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="md:col-span-3" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="email" className="md:text-right">Email</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="md:col-span-3" />
          </div>

          {!editId && (
            <>
              <div className="mt-4 mb-2">
                <h3 className="text-lg font-medium">Administrator Account</h3>
                <p className="text-sm text-muted-foreground">
                  An invite email will be sent to the administrator to set up their password.
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
                <Label htmlFor="adminName" className="md:text-right">Admin Name</Label>
                <Input id="adminName" value={adminName} onChange={(e) => setAdminName(e.target.value)} className="md:col-span-3" required={!editId} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
                <Label htmlFor="adminEmail" className="md:text-right">Admin Email</Label>
                <Input id="adminEmail" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="md:col-span-3" required={!editId} />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
                <Label htmlFor="adminPhone" className="md:text-right">Admin Phone</Label>
                <Input id="adminPhone" value={adminPhone} onChange={(e) => setAdminPhone(e.target.value)} className="md:col-span-3" />
              </div>
            </>
          )}

          <div className="mt-4 mb-2">
            <h3 className="text-lg font-medium">Organization Details</h3>
            <p className="text-sm text-muted-foreground">Additional organization information</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="address" className="md:text-right">Address</Label>
            <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} className="md:col-span-3" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="city" className="md:text-right">City</Label>
            <Input id="city" value={city} onChange={(e) => setCity(e.target.value)} className="md:col-span-3" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="state" className="md:text-right">State</Label>
            <Input id="state" value={state} onChange={(e) => setState(e.target.value)} className="md:col-span-3" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 items-center gap-2 md:gap-4">
            <Label htmlFor="zipCode" className="md:text-right">ZIP Code</Label>
            <Input id="zipCode" value={zipCode} onChange={(e) => setZipCode(e.target.value)} className="md:col-span-3" />
          </div>

          <OrganizationImageField
            id="logo"
            label="Logo"
            alt="Organization logo"
            helpText="Upload your organization logo (PNG, JPG, SVG - max 2MB)."
            tooLargeDescription="The logo file must be less than 2MB."
            preview={logoPreview}
            inputRef={fileInputRef}
            containerClassName="grid grid-cols-1 md:grid-cols-4 items-start gap-2 md:gap-4 mt-4"
            previewWrapperClassName="relative size-40 rounded-md overflow-hidden border"
            toast={toast}
            setValue={setLogo}
            setPreview={setLogoPreview}
          />

          <OrganizationImageField
            id="darkLogo"
            label="Dark Logo"
            alt="Dark background logo"
            helpText="Logo for dark backgrounds (sidebar navigation). Use a light/white version."
            tooLargeDescription="The logo file must be less than 2MB."
            preview={darkLogoPreview}
            inputRef={darkFileInputRef}
            containerClassName="grid grid-cols-1 md:grid-cols-4 items-start gap-2 md:gap-4"
            previewWrapperClassName="relative size-40 rounded-md overflow-hidden border bg-slate-900"
            toast={toast}
            setValue={setDarkLogo}
            setPreview={setDarkLogoPreview}
          />

          <OrganizationImageField
            id="appIcon"
            label="App Icon"
            alt="App icon"
            helpText="Square icon for phone home screens and browser tabs. Use a simple, recognizable icon (PNG - max 2MB). Falls back to the main logo if not set."
            tooLargeDescription="The app icon file must be less than 2MB."
            preview={appIconPreview}
            inputRef={appIconInputRef}
            containerClassName="grid grid-cols-1 md:grid-cols-4 items-start gap-2 md:gap-4"
            previewWrapperClassName="relative size-40 rounded-md overflow-hidden border"
            toast={toast}
            setValue={setAppIcon}
            setPreview={setAppIconPreview}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
            {editId ? 'Update' : 'Create'}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
