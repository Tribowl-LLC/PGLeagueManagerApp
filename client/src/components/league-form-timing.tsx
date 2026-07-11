import { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_TIMEZONE } from "@shared/schema";
import type { InsertLeagueInput, InsertLeague } from "@shared/schema";

interface LeagueTimingSectionProps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
}

export function LeagueTimingSection({ form }: LeagueTimingSectionProps) {
  return (
    <>
      <div className="grid grid-cols-1 gap-4">
        <FormField
          control={form.control}
          name="competitionStartTime"
          render={({ field }) => (
            <FormItem>
              <FormLabel>League Start Time</FormLabel>
              <FormControl>
                <Input
                  type="time"
                  {...field}
                  value={field.value || ''}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="timezone"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Timezone</FormLabel>
            <Select
              onValueChange={field.onChange}
              value={field.value || DEFAULT_TIMEZONE}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="America/New_York">Eastern (ET)</SelectItem>
                <SelectItem value="America/Chicago">Central (CT)</SelectItem>
                <SelectItem value="America/Denver">Mountain (MT)</SelectItem>
                <SelectItem value="America/Phoenix">Arizona (MST)</SelectItem>
                <SelectItem value="America/Los_Angeles">Pacific (PT)</SelectItem>
                <SelectItem value="America/Anchorage">Alaska (AKT)</SelectItem>
                <SelectItem value="Pacific/Honolulu">Hawaii (HST)</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
