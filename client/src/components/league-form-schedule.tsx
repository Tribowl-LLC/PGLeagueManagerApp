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
import type { InsertLeagueInput, InsertLeague } from "@shared/schema";

const weekDayOptions = [
  { value: "Monday", label: "Monday" },
  { value: "Tuesday", label: "Tuesday" },
  { value: "Wednesday", label: "Wednesday" },
  { value: "Thursday", label: "Thursday" },
  { value: "Friday", label: "Friday" },
  { value: "Saturday", label: "Saturday" },
  { value: "Sunday", label: "Sunday" },
];

interface LeagueScheduleSectionProps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  bowlingWeeks: number;
  computedSeasonEnd: Date | null;
  onSeasonStartChange: (isoString: string) => void;
  onBowlingWeeksChange: (weeks: number) => void;
}

export function LeagueScheduleSection({
  form,
  bowlingWeeks,
  computedSeasonEnd,
  onSeasonStartChange,
  onBowlingWeeksChange,
}: LeagueScheduleSectionProps) {
  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="seasonStart"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Season Start</FormLabel>
              <FormControl>
                <Input
                  type="date"
                  {...field}
                  value={field.value ? new Date(field.value).toISOString().split('T')[0] : ''}
                  onChange={(e) => {
                    const [year, month, day] = e.target.value.split('-').map(Number);
                    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
                    field.onChange(date.toISOString());
                    onSeasonStartChange(date.toISOString());
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div>
          <span className="text-sm font-medium">Season End</span>
          <div className="mt-1.5 flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
            {computedSeasonEnd
              ? computedSeasonEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : '—'}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Auto-calculated from schedule</p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <label htmlFor="bowling-weeks" className="text-sm font-medium">Bowling Weeks</label>
          <Input
            id="bowling-weeks"
            type="number"
            min={1}
            max={52}
            value={bowlingWeeks || ''}
            onChange={(e) => {
              const w = parseInt(e.target.value) || 1;
              onBowlingWeeksChange(w);
            }}
            placeholder="Number of bowling weeks"
            className="mt-1.5"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Total planned bowling weeks (not counting holidays/cancellations)
          </p>
        </div>

        <FormField
          control={form.control}
          name="weekDay"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Bowling Day</FormLabel>
              <Select
                onValueChange={field.onChange}
                value={field.value}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select bowling day" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {weekDayOptions.map((option) => (
                    <SelectItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </>
  );
}
