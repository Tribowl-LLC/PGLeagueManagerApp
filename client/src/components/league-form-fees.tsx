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
import {
  DEFAULT_WEEKLY_FEE_CENTS,
  type InsertLeagueInput,
  type InsertLeague,
  type Location,
  type PaymentMode,
} from "@shared/schema";
import { LeagueSquareCatalog } from "@/components/league-square-catalog";

interface LeagueFeeSectionProps {
  form: UseFormReturn<InsertLeagueInput, unknown, InsertLeague>;
  isUpfront: boolean;
  effectiveBowlingWeeks: number;
  activeLocations: Location[];
  watchedLocationId: number | null | undefined;
  watchedWeeklyFee: number;
  selectedCategoryId: string | null;
  onCategoryChange: (id: string | null) => void;
}

export function LeagueFeeSection({
  form,
  isUpfront,
  effectiveBowlingWeeks,
  activeLocations,
  watchedLocationId,
  watchedWeeklyFee,
  selectedCategoryId,
  onCategoryChange,
}: LeagueFeeSectionProps) {
  return (
    <>
      <FormField
        control={form.control}
        name="paymentMode"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Payment Mode</FormLabel>
            <Select
              onValueChange={(value) => field.onChange(value as PaymentMode)}
              value={field.value || "weekly"}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="weekly">Weekly: bowlers pay each week</SelectItem>
                <SelectItem value="upfront">Full Season Upfront: full amount due at start</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />

      {activeLocations.length > 0 && (
        <LeagueSquareCatalog
          form={form}
          locationId={watchedLocationId ?? null}
          selectedCategoryId={selectedCategoryId}
          onCategoryChange={onCategoryChange}
        />
      )}

      <FormField
        control={form.control}
        name="weeklyFee"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Weekly Fee</FormLabel>
            <FormControl>
              <Input
                type="number"
                min="0"
                step="0.01"
                {...field}
                value={(field.value ?? DEFAULT_WEEKLY_FEE_CENTS) / 100}
                onChange={(e) =>
                  field.onChange(Math.round(parseFloat(e.target.value) * 100))
                }
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="lineageFee"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Lineage Fee</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={field.value != null ? field.value / 100 : ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    field.onChange(val === "" ? null : Math.round(parseFloat(val) * 100));
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="prizeFundFee"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Prize Fund Fee</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={field.value != null ? field.value / 100 : ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    field.onChange(val === "" ? null : Math.round(parseFloat(val) * 100));
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      {(() => {
        const lf = form.watch('lineageFee');
        const pf = form.watch('prizeFundFee');
        const wf = form.watch('weeklyFee') ?? DEFAULT_WEEKLY_FEE_CENTS;
        if ((lf != null || pf != null) && wf > 0) {
          const total = (lf ?? 0) + (pf ?? 0);
          const matches = total === wf;
          return (
            <p className={`text-xs ${matches ? 'text-muted-foreground' : 'text-destructive'}`}>
              Lineage + Prize Fund = ${(total / 100).toFixed(2)} {matches ? '✓ matches weekly fee' : `— must equal $${(wf / 100).toFixed(2)}`}
            </p>
          );
        }
        return null;
      })()}

      {isUpfront && effectiveBowlingWeeks > 0 && watchedWeeklyFee > 0 && (
        <div className="rounded-lg border bg-muted/40 p-3 text-sm">
          <div className="font-medium">Full Season Total</div>
          <div className="text-muted-foreground mt-1">
            ${(watchedWeeklyFee / 100).toFixed(2)} &times; {effectiveBowlingWeeks} weeks ={" "}
            <span className="font-semibold text-foreground">
              ${((watchedWeeklyFee * effectiveBowlingWeeks) / 100).toFixed(2)}
            </span>{" "}
            due upfront per bowler
          </div>
        </div>
      )}

      <FormField
        control={form.control}
        name="active"
        render={({ field }) => (
          <FormItem className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <FormLabel>Active</FormLabel>
            </div>
            <FormControl>
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
              />
            </FormControl>
          </FormItem>
        )}
      />
    </>
  );
}
