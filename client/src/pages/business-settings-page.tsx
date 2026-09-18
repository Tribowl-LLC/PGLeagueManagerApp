import type { FormEvent } from 'react';
import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiResponse, Organization } from '@shared/schema';
import { Layout } from '@/components/layout';
import { BusinessSettingsImageField } from '@/components/business-settings-image-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageErrorState, PageLoadingState } from '@/components/page-states';
import { useToast } from '@/hooks/use-toast';
import { BUSINESS_CONTEXT_QUERY_KEY } from '@/hooks/use-business-context';
import { BUSINESS_SETTINGS_QUERY_KEY, useBusinessSettings } from '@/hooks/use-business-settings';
import { apiRequest } from '@/lib/queryClient';

interface BusinessSettingsValues {
  name: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
  email: string;
  logo: string | null;
  darkLogo: string | null;
  appIcon: string | null;
}

function toFormValues(business: Organization): BusinessSettingsValues {
  return {
    name: business.name,
    address: business.address ?? '',
    city: business.city ?? '',
    state: business.state ?? '',
    zipCode: business.zipCode ?? '',
    phone: business.phone ?? '',
    email: business.email ?? '',
    logo: business.logo,
    darkLogo: business.darkLogo,
    appIcon: business.appIcon,
  };
}

export default function BusinessSettingsPage() {
  const { business, isLoading, error, refetch } = useBusinessSettings();

  if (isLoading) {
    return (
      <Layout>
        <PageLoadingState message="Loading business settings…" />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <PageErrorState
          message={`We couldn't load business settings: ${error instanceof Error ? error.message : 'Please try again.'}`}
          onRetry={() => { void refetch(); }}
        />
      </Layout>
    );
  }

  if (!business) {
    return (
      <Layout>
        <PageErrorState
          message="Business settings are unavailable. Please try again."
          onRetry={() => { void refetch(); }}
        />
      </Layout>
    );
  }

  return <BusinessSettingsForm key={business.id} business={business} />;
}

function BusinessSettingsForm({ business }: { business: Organization }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const darkLogoInputRef = useRef<HTMLInputElement>(null);
  const appIconInputRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<BusinessSettingsValues>(() => toFormValues(business));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const updateValue = <T extends keyof BusinessSettingsValues>(field: T, value: BusinessSettingsValues[T]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setValidationError(null);
    setSavedMessage(null);
  };

  const saveMutation = useMutation({
    mutationFn: async () => apiRequest<Organization>('/api/business-settings', 'PATCH', {
      name: values.name.trim(),
      address: values.address.trim(),
      city: values.city.trim(),
      state: values.state.trim(),
      zipCode: values.zipCode.trim(),
      phone: values.phone.trim(),
      email: values.email.trim(),
      logo: values.logo,
      darkLogo: values.darkLogo,
      appIcon: values.appIcon,
    }),
    onSuccess: (response: ApiResponse<Organization>) => {
      if (response.data) {
        setValues(toFormValues(response.data));
        queryClient.setQueryData(BUSINESS_SETTINGS_QUERY_KEY, response);
      } else {
        void queryClient.invalidateQueries({ queryKey: BUSINESS_SETTINGS_QUERY_KEY });
      }
      void queryClient.invalidateQueries({ queryKey: BUSINESS_CONTEXT_QUERY_KEY });
      setSavedMessage('Business settings saved.');
      toast({ title: 'Business Settings Saved', description: 'Your business details and branding are up to date.' });
    },
    onError: (error: Error) => {
      toast({
        title: 'Unable to save business settings',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = values.name.trim();
    const email = values.email.trim();
    if (!name) {
      setValidationError('Business name is required.');
      return;
    }
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      setValidationError('Enter a valid business email address.');
      return;
    }
    setValidationError(null);
    saveMutation.mutate();
  };

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Business Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage the business details and branding shown across your league management app.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Business information</CardTitle>
              <CardDescription>Keep your public business contact details current.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="business-name">Name</Label>
                <Input id="business-name" value={values.name} onChange={(event) => updateValue('name', event.target.value)} required autoComplete="organization" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="business-address">Address</Label>
                <Input id="business-address" value={values.address} onChange={(event) => updateValue('address', event.target.value)} autoComplete="street-address" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-city">City</Label>
                <Input id="business-city" value={values.city} onChange={(event) => updateValue('city', event.target.value)} autoComplete="address-level2" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-state">State</Label>
                <Input id="business-state" value={values.state} onChange={(event) => updateValue('state', event.target.value)} autoComplete="address-level1" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-zip">ZIP</Label>
                <Input id="business-zip" value={values.zipCode} onChange={(event) => updateValue('zipCode', event.target.value)} autoComplete="postal-code" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="business-phone">Phone</Label>
                <Input id="business-phone" type="tel" value={values.phone} onChange={(event) => updateValue('phone', event.target.value)} autoComplete="tel" />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="business-email">Email</Label>
                <Input id="business-email" type="email" value={values.email} onChange={(event) => updateValue('email', event.target.value)} autoComplete="email" />
              </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Branding</CardTitle>
              <CardDescription>Upload the images used in navigation and installed app experiences.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 sm:grid-cols-3">
              <BusinessSettingsImageField
                id="business-logo"
                label="Logo"
                alt="Business logo preview"
                helpText="PNG, JPG, SVG, or another image format up to 2MB."
                preview={values.logo}
                inputRef={logoInputRef}
                toast={toast}
                onChange={(value) => updateValue('logo', value)}
              />
              <BusinessSettingsImageField
                id="business-dark-logo"
                label="Dark logo"
                alt="Dark logo preview"
                helpText="Use a light version for dark navigation backgrounds. Up to 2MB."
                preview={values.darkLogo}
                inputRef={darkLogoInputRef}
                toast={toast}
                onChange={(value) => updateValue('darkLogo', value)}
              />
              <BusinessSettingsImageField
                id="business-app-icon"
                label="App icon"
                alt="App icon preview"
                helpText="A square PNG or image for app icons and browser tabs, up to 2MB."
                preview={values.appIcon}
                inputRef={appIconInputRef}
                toast={toast}
                onChange={(value) => updateValue('appIcon', value)}
              />
              </div>
            </CardContent>
          </Card>

          {validationError && <p role="alert" className="text-sm text-destructive">{validationError}</p>}
          {savedMessage && <p role="status" aria-live="polite" className="text-sm text-positive-700">{savedMessage}</p>}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="submit" disabled={saveMutation.isPending} aria-busy={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
