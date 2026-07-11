import { FC } from "react";
import { UseFormReturn } from "react-hook-form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  FormControl,
  FormField,
  FormItem,
} from "@/components/ui/form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreditCard, Info, AlertTriangle } from "lucide-react";
import type { InsertPaymentInput, InsertPayment } from "@shared/schema";

interface PaymentMethodTabsProps {
  form: UseFormReturn<InsertPaymentInput, unknown, InsertPayment>;
  paymentType: string;
  squareLoadFailed: boolean;
}

export const PaymentMethodTabs: FC<PaymentMethodTabsProps> = ({
  form,
  paymentType,
  squareLoadFailed,
}) => {
  return (
    <>
      <div className="mb-4">
        <Tabs 
          value={paymentType === "credit_card" ? "credit" : (paymentType === "check" ? "check" : "cash")}
          onValueChange={(value) => {
            if (value === "credit") {
              form.setValue("type", "credit_card");
            } else if (value === "check") {
              form.setValue("type", "check");
            } else {
              form.setValue("type", "cash");
            }
          }}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger 
              value="cash" 
              className="flex items-center gap-2"
            >
              Cash
            </TabsTrigger>
            <TabsTrigger 
              value="check" 
              className="flex items-center gap-2"
            >
              Check
            </TabsTrigger>
            <TabsTrigger 
              disabled={squareLoadFailed}
              value="credit" 
              className="flex items-center gap-2"
            >
              <CreditCard className="size-4" />
              Credit Card
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="credit">
            {squareLoadFailed ? (
              <Alert variant="destructive" className="mb-4">
                <AlertTriangle className="size-4" />
                <AlertTitle>Credit Card Processing Unavailable</AlertTitle>
                <AlertDescription>
                  Credit card processing is temporarily unavailable. Please use cash or check payment methods instead.
                </AlertDescription>
              </Alert>
            ) : null}
          </TabsContent>
          
          <TabsContent value="cash">
            <Alert className="mb-4">
              <Info className="size-4" />
              <AlertDescription>
                Recording a cash payment. The payment will be marked as paid immediately.
              </AlertDescription>
            </Alert>
          </TabsContent>
          
          <TabsContent value="check">
            <Alert className="mb-4">
              <Info className="size-4" />
              <AlertDescription>
                Recording a check payment. Don't forget to add the check number below.
              </AlertDescription>
            </Alert>
          </TabsContent>
        </Tabs>
      </div>

      <FormField
        control={form.control}
        name="type"
        render={({ field }) => (
          <FormItem className="hidden">
            <FormControl>
              <RadioGroup
                onValueChange={field.onChange}
                value={field.value}
                className="hidden"
              >
                <RadioGroupItem value="cash" id="cash" />
                <RadioGroupItem value="check" id="check" />
                <RadioGroupItem value="credit_card" id="credit_card" />
              </RadioGroup>
            </FormControl>
          </FormItem>
        )}
      />
    </>
  );
};
