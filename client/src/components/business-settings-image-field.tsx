import type { ChangeEvent, RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { X } from 'lucide-react';

type ToastFn = ReturnType<typeof useToast>['toast'];

interface BusinessSettingsImageFieldProps {
  id: string;
  label: string;
  alt: string;
  helpText: string;
  preview: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  toast: ToastFn;
  onChange: (value: string | null) => void;
}

const MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024;

export function BusinessSettingsImageField({
  id,
  label,
  alt,
  helpText,
  preview,
  inputRef,
  toast,
  onChange,
}: BusinessSettingsImageFieldProps) {
  const helpId = `${id}-help`;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      toast({
        title: 'File too large',
        description: `${label} must be less than 2MB.`,
        variant: 'destructive',
      });
      event.currentTarget.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onChange(reader.result);
    };
    reader.onerror = () => {
      toast({
        title: 'Image could not be read',
        description: `Choose another image for ${label.toLowerCase()}.`,
        variant: 'destructive',
      });
      event.currentTarget.value = '';
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {preview ? (
        <div className="relative flex min-h-32 w-full items-center justify-center rounded-md border bg-muted/20 p-3 sm:size-40 sm:p-2">
          <img src={preview} alt={alt} className="max-h-32 w-full object-contain sm:h-full" />
          <Button
            type="button"
            variant="destructive"
            size="iconXs"
            shape="circular"
            className="absolute right-1 top-1"
            onClick={() => {
              onChange(null);
              if (inputRef.current) inputRef.current.value = '';
            }}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Input
          ref={inputRef}
          type="file"
          id={id}
          accept="image/*"
          aria-describedby={helpId}
          onChange={handleFileChange}
        />
      )}
      <p id={helpId} className="text-xs text-muted-foreground">{helpText}</p>
    </div>
  );
}
