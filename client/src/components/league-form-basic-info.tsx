import { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { InsertLeagueInput, InsertLeague, Location } from "@shared/schema";

interface LeagueBasicInfoProps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  activeLocations: Location[];
  onLocationChange: (value: string) => void;
  locationRequired?: boolean;
}

export function LeagueBasicInfo({ form, activeLocations, onLocationChange, locationRequired = false }: LeagueBasicInfoProps) {
  return (
    <>
      {(activeLocations.length > 0 || locationRequired) && (
        <FormField
          control={form.control}
          name="locationId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{locationRequired ? "Location (required)" : "Location"}</FormLabel>
              <Select
                onValueChange={(value) => {
                  field.onChange(value === "none" ? null : parseInt(value));
                  onLocationChange(value);
                }}
                value={field.value ? String(field.value) : locationRequired ? "" : "none"}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a location" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {!locationRequired && <SelectItem value="none">No Location</SelectItem>}
                  {activeLocations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="payingLineupSize"
        render={({ field }) => (
          <FormItem>
            <FormLabel>League Lineup Size</FormLabel>
            <Select value={field.value ? String(field.value) : ""} onValueChange={(value) => field.onChange(Number(value))}>
              <FormControl>
                <SelectTrigger><SelectValue placeholder="Choose a lineup size" /></SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="3">Three Bowlers</SelectItem>
                <SelectItem value="4">Four Bowlers</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="substituteAccess"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Substitute access</FormLabel>
            <Select value={field.value ?? "team_only"} onValueChange={field.onChange}>
              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="team_only">Team members only</SelectItem>
                <SelectItem value="floating">Any active league member</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="substitutePaymentRegime"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Substitute payment regime</FormLabel>
            <Select value={field.value ?? "team_choice"} onValueChange={field.onChange}>
              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="team_choice">Team chooses payer policy</SelectItem>
                <SelectItem value="league_lineage_prize_split">Substitute lineage / Main prize split</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="allowPublicSignup"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Allow Public Sign-up</FormLabel>
              <p className="text-sm text-muted-foreground">
                When enabled, this league will appear on the public sign-up page
              </p>
            </div>
            <FormControl>
              <Switch
                checked={field.value ?? false}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />

    </>
  );
}
