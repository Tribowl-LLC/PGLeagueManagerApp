import type { RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { X } from 'lucide-react';
import type { useToast } from '@/hooks/use-toast';

type ToastFn = ReturnType<typeof useToast>['toast'];

interface OrganizationImageFieldProps {
  id: string;
  label: string;
  alt: string;
  helpText: string;
  tooLargeDescription: string;
  preview: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  containerClassName: string;
  previewWrapperClassName: string;
  toast: ToastFn;
  setValue: (v: string | null) => void;
  setPreview: (v: string | null) => void;
}

export function OrganizationImageField({
  id,
  label,
  alt,
  helpText,
  tooLargeDescription,
  preview,
  inputRef,
  containerClassName,
  previewWrapperClassName,
  toast,
  setValue,
  setPreview,
}: OrganizationImageFieldProps) {
  return (
    <div className={containerClassName}>
      <Label htmlFor={id} className="md:text-right pt-2">{label}</Label>
      <div className="md:col-span-3 space-y-2">
        {preview ? (
          <div className={previewWrapperClassName}>
            <img src={preview} alt={alt} className="w-full h-full object-contain" />
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="absolute top-1 right-1 size-6 rounded-full"
              onClick={() => {
                setValue(null);
                setPreview(null);
                if (inputRef.current) inputRef.current.value = '';
              }}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <div className="w-full">
            <div className="flex items-center gap-2">
              <Input
                ref={inputRef}
                type="file"
                id={id}
                accept="image/*"
                className="flex-1"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  if (file.size > 2 * 1024 * 1024) {
                    toast({ title: "File too large", description: tooLargeDescription, variant: "destructive" });
                    return;
                  }
                  const reader = new FileReader();
                  reader.onload = (event) => {
                    const base64 = event.target?.result as string;
                    setValue(base64);
                    setPreview(base64);
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{helpText}</p>
          </div>
        )}
      </div>
    </div>
  );
}
