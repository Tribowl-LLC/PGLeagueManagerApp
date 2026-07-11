import { FC } from "react";
import { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { InsertPaymentInput, InsertPayment, Bowler } from "@shared/schema";

interface PaymentFormFieldsProps {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
  bowlers: Bowler[];
}

export const PaymentFormFields: FC<PaymentFormFieldsProps> = ({ form, bowlers }) => {
  return (
    <>
      <FormField
        control={form.control}
        name="bowlerId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Bowler</FormLabel>
            <FormControl>
              <select
                {...field}
                className="w-full p-2 border rounded"
                value={field.value || ""}
                onChange={(e) => {
                  const value = e.target.value ? parseInt(e.target.value, 10) : undefined;
                  field.onChange(value);
                }}
              >
                <option value="">Select a bowler</option>
                {bowlers.map((bowler) => (
                  <option key={bowler.id} value={bowler.id}>
                    {bowler.name}
                  </option>
                ))}
              </select>
            </FormControl>
            <FormMessage>
              {form.formState.errors.bowlerId?.message ||
               (!field.value && "Please select a bowler")}
            </FormMessage>
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="amount"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Amount ($)</FormLabel>
            <FormControl>
              <Input
                type="number"
                step="0.01"
                {...field}
                onChange={(e) => {
                  const dollars = parseFloat(e.target.value);
                  field.onChange(Math.round(dollars * 100));
                }}
                value={(field.value / 100).toFixed(2)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="weekOf"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Week Of</FormLabel>
            <FormControl>
              <Input
                type="date"
                {...field}
                value={field.value ? new Date(field.value).toISOString().split('T')[0] : ''}
                onChange={(e) => field.onChange(new Date(e.target.value).toISOString())}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
};
