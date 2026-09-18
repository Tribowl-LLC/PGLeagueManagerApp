import type { UseFormReturn } from "react-hook-form";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LANGUAGE_AUTO,
  LANGUAGE_OPTIONS,
} from "@/lib/preferred-language";
import type { ProfileFormData } from "./profile-info-card";

interface ProfileInfoFormProps {
  form: UseFormReturn<ProfileFormData>;
  isSaving: boolean;
  onSubmit: (data: ProfileFormData) => void;
  onCancel: () => void;
}

export function ProfileInfoForm({ form, isSaving, onSubmit, onCancel }: ProfileInfoFormProps) {
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl><Input type="email" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="currentPassword"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Current password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Required only when changing email"
                  {...field}
                />
              </FormControl>
              <p className="text-xs text-muted-foreground">
                Re-enter your password to authorize a sign-in email change.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl>
                <Input type="tel" placeholder="(555) 555-5555" {...field} value={field.value || ""} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="preferredLanguage"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Preferred language</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
              >
                <FormControl>
                  <SelectTrigger data-testid="select-preferred-language">
                    <SelectValue placeholder="Auto (follow my browser)" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={LANGUAGE_AUTO} data-testid="option-language-auto">
                    Auto (follow my browser)
                  </SelectItem>
                  {LANGUAGE_OPTIONS.map(opt => (
                    <SelectItem
                      key={opt.value}
                      value={opt.value}
                      data-testid={`option-language-${opt.value}`}
                    >
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Used for security emails like password-change notifications.
              </p>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={isSaving}>
            {isSaving ? (
              <><Loader2 className="mr-2 size-4 animate-spin" />Saving…</>
            ) : (
              <><Save className="mr-2 size-4" />Save Changes</>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </Form>
  );
}
