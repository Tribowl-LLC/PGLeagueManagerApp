import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";

interface PaymentCheckNumberFieldProps {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
}

export function PaymentCheckNumberField({ form }: PaymentCheckNumberFieldProps) {
  return (
    <FormField
      control={form.control}
      name="checkNumber"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Check Number</FormLabel>
          <FormControl>
            <Input {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
